- 2026-09-15 `feat/iterative-effects` — **DESIGN §3.156, ITERATIVE EFFECTS (`repeat this process`).**
  **Primal Surge ✅ and Grindstone ✅. +2 cards, 0 lost, set-verified** (7,040 -> 7,042 on a fixed
  32,341-card corpus; this lane's seven sources reverted with `git show origin/main:<path>` and both
  trees rebuilt in between; the diff both ways names exactly those two and nothing else).
  Worktree `D:/Cool Stuff/Claude/jb-repeat`, forked from `origin/main` `40f4227`. **NOT PUSHED** —
  the brief forbade `git push`; the branch is local in that worktree, **19 commits**, merged TWICE —
  with `origin/main` `ea9342a` and again with `c8cc7a6` (the §3.155 lane's own merge, PR #58) after
  `main` moved under this lane a second time. **The second merge was verified with the three checks
  the first one earned** and came back clean: no unexpected file differs from `main`, all 316 of
  `main`'s rule ids are present plus this lane's 2, and the playable set is **7,040 -> 7,042, +2/−0**
  re-measured against `c8cc7a6` rather than carried over from the earlier merge.
  **NEW `packages/cards/scripts/repeat-blame.mjs`** — the ninth blame tool. 44 cards print "repeat",
  all 44 blocked, **38 clauses / 38 shapes = 1.00 per shape**: the §3.120 artifact at its FLOOR for
  the second time. ⚠️ **There is no iteration row in `UNSUPPORTED_HINTS` at all** — the family is
  scattered across **14** rows, so selecting by hint would have found ZERO of it. That is a stronger
  result than §7c item 5's 68%: the hint cannot see the family.
  ⚠️ **THE ROW NAME POINTED AT THE WRONG HALF, AND SO DID THE CORRECTION.** The board says "you may /
  choose"; §7b corrected that to `repeat this process`. Both are half right: the gap is the BODIES 23
  clauses to 15, and **Primal Surge is in the BODY bucket** — with the repeat sentence deleted it
  still refuses. Exactly ONE corpus card compiles on the iteration alone, and it is Grindstone.
  **FILES OWNED** (`rules.ts` is contended — expect a real merge, and build after it):
  `packages/cards/src/compile/rules.ts` — **one region only**: a `§3.156` block declared immediately
  ABOVE `export const EFFECT_RULES` (it must be above it: a `const` spread into that array from below
  is a TDZ error), reaching the array through **one spread line** `...ITERATIVE_EFFECT_RULES,` at its
  end. Nothing else in the file is touched. `packages/cards/src/compile/compile.ts` — **one ROW**:
  `millSharedColorRepeat` added to `PRIMITIVE_BACKED_KEYWORDS.mill`. `packages/cards/src/primitives.ts`
  — one import + one spread. **NEW `packages/cards/src/iterative-primitives.ts`**, **NEW
  `packages/cards/src/iterative-effects.test.ts`**, **NEW `packages/cards/scripts/repeat-blame.mjs`**.
  `packages/core/src/choices.ts` · `engine.ts` · `index.ts` · `choice-cards.test.ts`.
  ⚠️⚠️ **READ THIS ONE FIRST: THE `origin/main` MERGE SILENTLY DROPPED §3.155, AND EVERYTHING WAS
  GREEN.** `git merge` reported `rules.ts` and `primitives.ts` as AUTO-MERGED with no conflict; the
  build passed, every type-check passed, and `packages/cards` ran **118 files / 22,433 tests, exit 0**.
  The playable SET is what caught it:
  ```
  origin/main      7,040 complete
  merged branch    6,938 complete     -> +2 gained, 104 LOST
  ```
  The 104 are one shape — Akroan Phalanx, Burn Bright, Charge, Overrun, **Craterhoof Behemoth** —
  because two hunks resolved in favour of the pre-merge side: `rules.ts` kept the SUPERSEDED
  `mass-grant-keyword-until-eot` and lost `mass-modify-yours-until-eot` (316 rule ids on main, 315 on
  the branch), and `primitives.ts` reverted `grantKeywordToYoursUntilEndOfTurn` to its keyword-only
  form, dropping the P/T half. Both files are now rebuilt as **main's content plus this lane's
  additions only** — `rules.ts` +144/−0, `primitives.ts` +8/−0, all 316 of main's rule ids present.
  **Craterhoof Behemoth is another lane's §7a acceptance card.** Had this shipped, that card would
  have stopped compiling and the board would still have said it was done.
  ⚠️ **AND TWO FILES WAS NOT THE EXTENT.** Repairing those two made the suite go RED on a test this
  lane never touched: §3.155 had UPDATED `template-gaps.test.ts` alongside its rule, and the merge
  reverted BOTH — so they agreed with each other and 22,433 tests passed. The inconsistency was
  invisible while both halves were wrong. A file-by-file audit found five more casualties, all
  §3.155's: `mass-modification-family.test.ts` (**462 lines, deleted**), `masspump-blame.mjs`
  (**243 lines, deleted**), `ai/src/effect-value.ts` (−70/+30), `effect-value-parity.test.ts`
  (**33 lines, deleted**), `template-gaps.test.ts` (−10/+2). All restored verbatim from `origin/main`.
  → **Integrators, three checks after ANY merge — no gate does these on its own:** (1) run
  `git diff --name-only origin/main` and **justify every entry**; a file you did not touch appearing
  there is the finding, and two of these were DELETIONS that no diff-of-my-own-files would show.
  (2) diff the rule ids (`grep -o "id: '[a-z0-9-]*'" | sort -u`) against `origin/main`. (3) re-run
  `playable-set.mjs` both ways — a count says +2, only the SET says −104. (And `git show` hands you
  LF while the working tree is CRLF — splice with matched endings or the repair silently no-ops.)
  ⚠️ **A CORE CONSTANT WAS RENAMED, BUT ITS VALUE DID NOT MOVE — no lane's expectation changes.**
  `MAX_CHOICES_PER_RESOLUTION` (32) is now `MAX_CHOICES_PER_EFFECT_REF` (32), counted PER EFFECT REF
  instead of per frame, with a new sibling `MAX_EFFECT_STEPS_PER_RESOLUTION` (216) bounding the frame.
  If you hold a literal 32 in a choice loop, read the constant instead — `choice-cards.test.ts` had a
  literal 200 that silently stopped bounding anything, and now derives from the constant.
  ⚠️ **THE ROUTE TO THAT SPLIT IS THE PART WORTH READING, because two drafts of it were wrong.** The
  first raised the frame-wide ceiling to 400 ("comfortably generous", nothing measured behind the 4).
  `packages/cards` then took **90 minutes on one file** and the cheap explanation — the merged pool is
  bigger — was available and WRONG. Measured on the same tree, one filtered whole-pool test:
  **32 → 1295.31s = 21.6 min · 400 → >54 min · 116 → >105 min CPU.** The pool holds resolutions that
  legitimately ask in long loops (a copy mirror, a big storm count); at 32 they were being TRUNCATED,
  and raising the ceiling makes them FINISH, which costs time. So a ceiling is a budget somebody
  actually spends. The second draft chased the smallest number (116) and still bought 3.6×.
  **The number was never the mistake — the COUNTER was**: a frame-wide total cannot tell "one
  primitive looping" (a bug, per-ref) from "many primitives each asking once" (an iterative card, and
  legal). Split, both are bounded and neither pays for the other. Pinned by deleting the one-line
  reset: **23 of 56 cards stranded in the library**, red, restored.
  **If you re-tune either constant, re-run that filtered test on both sides** — a whole-pool
  measurement is a direct multiple of the ask ceiling, and nothing in the suite says so on its own.
  ⚠️ **The new bound exists because the old one could not SEE this class** — a resolution that will not
  stop ENQUEUEING asks nothing, takes no action and ends no turn, so it is invisible to the ask budget,
  to the sim's per-turn bound and to the soak's `gameCanEnd`. It hung the process instead of losing a
  game. §3.140's blindness one layer in; both bounds now abandon through one `abandonResolution` funnel
  and the same `choiceAbandoned` event, so no soak table or observation row needed a new entry.
  **GATE, derived from the FINAL diff** (`git diff --name-only origin/main...HEAD | cut -d/ -f1-2 |
  sort -u` = `packages/ai` + `packages/cards` + `packages/core`), each run separately, exit codes
  quoted, nothing piped:
  · `npm run build` **exit 0** (unpiped; it OOMs at exit 134 under default heap while other lanes
    build — `NODE_OPTIONS=--max-old-space-size=4096` fixes it. A BOX limit, not a code failure.)
  · `vitest packages/core` **exit 0 — 100 files / 1,406 tests**, 0 `Worker exited`, 100 == 100
    `*.test.ts` on disk.
  · `vitest packages/cards packages/ai` **exit 0 — 173 files / 23,015 tests**, 0 `Worker exited`,
    0 skipped.
  · combined `cards`+`core` = **218 files / 23,839 tests** against main's baseline of **217 /
    23,825** — **+1 file / +14 tests, which is exactly this lane's one new test file.**
  · `packages/sim` is NOT in the diff, but `loop-runaway.test.ts` + `loop-draw.test.ts` own the
    "this game cannot end" class this lane touched, so they were run anyway: **exit 0, 2 files / 9
    tests.** The two pre-existing soak failures main carries were not re-run and are **NOT CHECKED**
    by this lane.
  **THROUGHPUT** (`sim -- gauntlet "Mono-Red Aggro" --games 40 --seed 99`), three runs each side,
  interleaved with rebuilds: `origin/main` **95.3 / 106 / 102 games/sec**, this branch **92.5 / 93.9
  / 101**. Ranges overlap and this box is known to swing 20 g/s on identical code, so: **no
  measurable regression, and no speedup claimed.** Outcomes **byte-identical on both sides** —
  97/320 = 30.3%, rows 17·14·19·7·8·10·17·5, 1 timeout draw.
  **AND THE ONE THAT MATTERS FOR RULE 7**: `expanded-pool.test.ts`, the whole-pool game, ran
  **20.1 and 30.5 min** on the final tree against **21.6 min measured at main's own ceiling** —
  overlapping and load-dominated. The intermediate designs were >54 min and >105 min. Parity is
  restored, not traded away.
  ⚠️ **Two traps this lane paid for twice, worth the next agent's ten seconds:**
  (1) `git checkout -- <path>` restores to the last COMMIT, not to the pre-sabotage working tree. It
  silently deleted an uncommitted export mid-falsification, and the test then failed with "undefined
  and string", which reads exactly like a circular-import bug and is not one. **Commit before a
  falsification pass.**
  (2) The documented Bash-heredoc backslash mangling is live: a region appended with `cat >>` reached
  disk one backslash short: a template literal needs a DOUBLED backslash to put an escaped dot into the
  regex, and what landed was the single form — which inside a template literal is just a dot, matching
  ANY character. The card still compiled, so no test could see it; **eslint's `no-useless-escape` was
  the only thing that did.** Run lint on your own files, not just the suite. (Written with the Write/Edit
  tool, because saying this through a heredoc ate the backslashes a third time.)
- 2026-09-15 **INTEGRATOR NOTE — the in-flight pool chain carries the OLD deck names** (integrator).
  `main` renamed the photo decks on 2026-09-15 (`acidic-angels.txt` → `thunes-life.txt`,
  `defender-ramp.txt` → `tamiyo-jace-surge.txt`) and added the REAL `acidic-angels.txt`, which is a
  different 16-name deck. **`fix/attachment-unlink` and `fix/glossary-pool-coverage` forked before
  that** and still say the old names in comments, DESIGN/COORDINATION prose and test `describe`
  headings.
  ✅ **Textually and semantically safe to merge** — checked: `verify-deck-cards-reachable.mjs` uses a
  hardcoded `DECK_CARDS` array and does **not** read `docs/decks/*.txt`, and every other hit is a
  comment or a describe string. A `merge-tree` dry run against `main` reports **zero conflicts**.
  ⚠️ **But the LABELS are wrong and must be fixed at merge, not after.** That chain reports
  *"acidic-angels 22/22 distinct, 65/65 copies"* — those are **Thune's Life**'s numbers. The real
  Acidic Angels is **16 names / 59 copies**. Shipping the branch text unedited would re-introduce
  exactly the confusion that took three rounds to correct, into the file that is supposed to be the
  authority on it.
  **At merge:** rewrite those labels to `Thune's Life`, and leave every `Acidic Angels` in
  `apps/web/src/lib/decklist/*` and DESIGN §3.35 alone — there it means the deck Caleb really did
  rename from the built-in, which is the same deck as the new `acidic-angels.txt`.
  ⚠️ **Do not fix this by editing the live lanes' worktrees.** A lane that reported complete was
  resumed by an unrelated message this week and found three commits it had not made; it re-ran its
  whole gate, correctly, but that is cost. The integrator owns the merge — fix it there.

- 2026-09-15 **A FAILING TEST REACHED `main`, AND THE CAUSE WAS MY BRIEF, NOT THE LANE** (integrator).
  `apps/web/src/lib/play/keyword-glossary.test.ts` was red on `main` for three merges. The lane that
  caused it did nothing wrong: it **declared** its two `apps/web` rows in its report, and it ran
  exactly the gate I specified — `npx vitest run packages/cards packages/core`. **That gate cannot
  see `apps/web`.** So a lane can be fully honest, fully green against its stated gate, and still
  land a red test.
  The defect: the card-lane brief hard-codes its gate **in advance**, while the files a lane ends up
  touching are only known **afterwards**. Two lanes declared `apps/web` edits this wave; one was
  type-only (the build caught it) and one was a data row with a test behind it (nothing caught it).
  ✅ **The rule, for every future brief:** *the gate is derived from the diff, not fixed in the
  brief.* Run `git diff --name-only origin/main...HEAD | cut -d/ -f1-2 | sort -u` and run the suite
  for **every** package or app it names. If that is too heavy for this box, run them **separately**
  and quote each exit code — never drop one silently. `npm run verify` at the root is the full gate
  and is correct but too large to run here while lanes are live; that is a RAM constraint, not
  permission to test less than you changed.
  ⚠️ **The failure was found by a lane working on something else entirely** — the card-browser crash
  lane reported it as "the one failing test is not mine and is not fixed", named it precisely, and
  proved its own branch touched none of its inputs. That is the right behaviour and worth copying:
  **report a red you did not cause, name it, and prove it is not yours.** Do not fix it silently and
  do not fold it into your own result.
  The citation itself: `rules-manifest.ts` correctly says **`702.11e`** (hexproof-from is its own CR
  702 keyword; citing the parent `702.11` makes two keyword abilities claim one number, which GAP-15
  refuses by construction), while the web glossary still said `702.11`. Fixed here.

- 2026-09-15 `feat/replacement-prevention` — ⚠️ **ANOTHER SESSION COMMITTED INTO THIS WORKTREE
  MID-LANE**, and the re-verification it forced is the entry worth reading.
  After this lane's gate went green at `f3288a5`, two commits appeared on the branch that this lane
  did not make: `f14642b` (a merge of `origin/main`, bringing the modal and copy-selector lanes —
  **`rules.ts` +302, `core/targeting.ts` +299, `compile.ts` +103**) and `8b0f973` (a docs commit).
  **A green measured before a merge is not a green after it** — this repo has had a clean textual
  merge produce 269 compile errors. Everything below was therefore re-run on the merged tree:
  `npm run build` **exit 0**, the playable set re-measured (**all 29 of this lane's cards still
  compile, nothing lost versus the pre-merge measurement**; the absolute rose to 6,945 because the
  other two lanes landed ~210 of their own), and the full `packages/cards packages/core` gate re-run.
  The merge was clean semantically as well as textually — but that is a MEASUREMENT, not an
  assumption, and it is the only reason it can be said.
  ⚠️ The same merge left **§8a of `ALL-CARDS-CAMPAIGN.md` carrying one finding twice** and three of
  this lane's items orphaned after the blockquote. De-duplicated in `0603c06`; §8a is a single 1-10
  again. **Auto-merge does not renumber a list, and nothing fails when it doesn't.**
  Worktree `D:/Cool Stuff/Claude/jb-replace`, forked from `origin/main` `162f143`.
  **DESIGN §3.151 — REPLACEMENT AND PREVENTION. Rhox Faithmender ✅ and Fog Bank ✅. +29 cards, 0 lost,
  set-verified** (6,706 → 6,735 on a fixed 32,414-card corpus, this lane's nine sources reverted with
  `git show 162f143:<path>` and rebuilt in between).
  **NEW `packages/cards/scripts/replace-blame.mjs`** — the eighth blame tool. The row's name points at
  the wrong half for the SIXTH consecutive lane: it names the **event kind**, and adding one cost *one
  row in five places* with **no new field and no new branch**. The family's real mass is **412 clauses /
  303 sole-blocked cards on event kinds the layer ALREADY watched** — the gap is the printed WORDING.
  ⚠️ **Selection by TEXT finds 916 cards against 142 by hint — 774 of this shape sit in other rows.**
  By CLAUSE (a different number, not quotable as the card count) the largest destination is the §2
  aggregation-artifact row with 302, *which is where Fog Bank itself was filed.* A lane scoping from
  the hint row would never have seen its own acceptance card. §7b's leakage warning is now measured on
  a second family.
  **FILES OWNED** (`rules.ts` is the six-way contender — expect a real merge, and build after it):
  `packages/cards/src/compile/rules.ts` — **two regions only**: (1) new closed tables
  `PREVENTION_STATIC_SUBJECTS` / `PREVENTION_SOURCE_CLASSES` / `LIFEGAIN_SUBJECTS`, appended after
  `REPLACEMENT_MULTIPLIER_TOKEN`; (2) the `replacement-prevent-all-static` rule REWRITTEN in place plus
  a new `replacement-lifegain` rule immediately after it. Nothing else in the file is touched.
  `packages/core/src/replacement.ts` · `internal/replacement.ts` · `internal/damage-result.ts` ·
  `index.ts` · `events.ts` · **NEW `core/src/life.ts`** · `packages/cards/src/effect-helpers.ts` ·
  `primitives.ts` · NEW tests `core/src/life.test.ts`, `cards/src/replacement-lifegain.test.ts`.
  ⚠️ **SEMANTIC CONFLICTS for the integrator, three:**
  1. **`ReplacementEventKind` gained a fifth member (`'lifegain'`).** Any lane that `switch`es on it
     exhaustively, or restates its members, will fail to compile — which is the desired outcome.
     `events.ts` DID restate it, behind a comment claiming a pinning test that does not exist; the copy
     was deleted rather than extended. If another lane re-adds a copy, delete theirs too.
  2. **`effect-helpers.changeLife` now RETURNS the applied delta** (was `void`) and runs the CR 614
     layer for a positive delta. Any lane that added a `changeLife` caller and emits its own `gainLife`
     must read the return value, or it will log the printed amount instead of the gained one. Three
     callers existed and all three were updated.
  3. **`replacement-prevent-all-static`'s regex was replaced**, not extended. A lane that added a
     recipient phrase to the old inline alternation must move it to `PREVENTION_STATIC_SUBJECTS` as a
     row — and give it an honest `dealer` projection or `null`.
  ⚠️ **`expanded-pool.test.ts` does NOT cover these 29 cards** — it reads the COMMITTED
  `data/expanded-pool.ts` (5,619 definitions, the stale baseline), and all 29 were blocked when that
  was generated. Re-established three ways instead: 8 of the 29 are PLAYED in the new test file; all
  29 checked structurally (complete · a non-inert replacement · closed kind+anchor · every referenced
  primitive registered, against a registry of 105); and the inert-declaration trap is now a committed
  `it.each` guard. **When `fix/pool-refresh-3147` regenerates, these 29 come into that sweep's scope
  for the first time** — worth a look at that run.
  **DID NOT DO, by name:** the regenerated pool and card index are untouched (owned by
  `fix/pool-refresh-3147`). `apps/web` untouched — no compile-time-exhaustive table needed a row.
  The **zone-change destination vocabulary** (`dies` 63, `zoneToGraveyard` 42, `leavesBattlefield` 13,
  `entersBattlefield` 12 = **130 sole-blocked cards**) is left REPORTED; it is four times this lane's
  delta and is the right next pick in this family. `lifeloss` (4) left reported — every printed member
  also needs a *"during your turn"* condition the filter cannot state.
- 2026-09-15 **CORRECTION to my own wave-5 collision note, and a verdict on the two stranded lanes** (integrator).
  I told two in-flight lanes to study `origin/feat/trigger-body-templates` as a live collision. **That
  was wrong in a way worth recording, because the method that produced it looks reliable and is not.**
  I read `git diff --stat origin/main...origin/feat/trigger-body-templates`, saw `choice-primitives.ts`
  as +115 with no deletions, and concluded it was a NEW file. **An all-additions diffstat does not mean
  a new file** — it means that branch only added lines to it. The `jb-modal` lane checked and told me
  so: `choice-primitives.ts` already exists on `main`. Use `git diff --name-status` or
  `git log --diff-filter=A`, never a line count, to answer "is this new".
  ⚠️ **And the branch is superseded, not stranded.** `feat/trigger-body-templates-v2` (`2b8303a`) is
  already contained in `origin/main`, which is why a dry-run merge of v1 reports an **add/add conflict
  on `trigger-body-templates.test.ts`** — both sides create a file main already has. Merging v1 now
  would re-land a superseded implementation. **Verdict: CLOSE `feat/trigger-body-templates`.** The
  dry-run cost one command: `git merge-tree --write-tree --name-only origin/main origin/<branch>`
  reports the conflict surface without touching a worktree, and it is how this was caught.
  ✅ **`feat/copy-templates` (`c1e2320`) is genuinely stranded and genuinely mergeable.** Its own entry
  above says SHIPPED with a gate: +3 as a set diff, 0 lost, gauntlet byte-identical, and it documents
  that the audit row's "21 cards" headline was really 3. Against today's `main` it dry-runs to just
  **two conflicts** — `COORDINATION.md` (additive) and `packages/core/src/engine.ts`. Its gate predates
  seven compiler families, so it needs a real build+test after merging, not a textual merge and a
  green memory. `feat/copy-selectors` already diffed it read-only and found **no hunk overlap** (that
  branch changes `copySpell`; copy-selectors changed `createTokenCopy`). **Verdict: MERGE it.**
  ⚠️ **Inventory remote heads AND check for a `-v2`.** `git branch -r --no-merged origin/main` finds
  the stranded ones; `git branch -r --contains <branch>` tells you whether a successor already landed.
  Neither is visible from `git worktree list`.

- 2026-09-15 `feat/modal-templates` — ✅ **committed, NOT pushed / NOT merged** (worker; integrator merges).
  **§3.150 — the MODAL row contains no modal work at all, and the row's name is wrong ABSOLUTELY.**
  The row named 432 cards and blocks Selesnya Charm. Measured against a freshly fetched 32,414-card
  corpus with NEW `packages/cards/scripts/modal-blame.mjs`: **531 clauses across 504 distinct shapes —
  1.05 per shape**, the §3.120 artifact for the FIFTH row running and the thinnest ratio yet
  (1.20 → 1.18 → 1.13 → 1.08 → **1.05**). The script re-probes each bullet IN A MODAL HARNESS on the
  card's own type line and prefix, splitting the row three ways: **MODE-ONLY = 0**, BODY = 408 clauses
  (392 sole), HEADER = 166 (29 sole), NOT-PROBEABLE = 135 (reported, never bucketed).
  ⚠️ **MODE-ONLY IS ZERO — core's `modal.ts` and the cast-time mode/target pipeline have NO gaps.** A
  lane that took this row at its name would have rebuilt a finished system. Every card in it is held
  by a mode BODY belonging to another family, or by a header shape.
  ⚠️ **THE HINT-ORDER TRAP IS REAL AND LARGE, and the next agent should not trust any row's count.**
  `UNSUPPORTED_HINTS` is first-match and the modal hint is anchored `^choose …`, so **every modal
  TRIGGER** cannot reach it: 518 blocked cards print a modal header while the row claims 531, with 145
  clauses filed under *"a you may / choose template"* and 8 more under five other rows because a
  bullet contained an earlier hint's word.
  **Shipped instead: the printed BOUND on a target selector** — the largest concentrated shape in the
  BODY bucket, measured corpus-wide BEFORE building (rule 11) at 233 cards on the targeting seam of
  which only 32 are modal. So it was built as the CLASS, not the instance.
  `TargetBound` rides WITH the restriction (`TargetSpec = TargetRestriction | { base, bound }`),
  because a bound carries a NUMBER and a second positional argument through the ~14 call sites of
  `isLegalTarget`/`legalTargetsFor` fails the moment one site forgets it — that site would police the
  noun and silently ignore the bound, a card playing WIDER than printed. Enforced at all three points
  (offer / accept / resolve). Mana value reads through `convertedManaCost`, never a second sum.
  The compiler side is **ONE PRE-PASS in `applyRules`**, beside the `where X is …` binding §3.149 put
  there and for the same reason: the SENTENCES were never missing. Destroy (75 corpus clauses), return
  (23), "deals N damage to" (19), exile (17), counter (9) and gain-control-of (4) gain the whole
  vocabulary in one edit instead of six copies of the noun table.
  📈 **Accepted-count delta +175, ZERO lost (6,663 → 6,838)** on ONE fixed corpus compiled twice with
  this lane's sixteen source files reverted in between via `git show <fork>:<path>` (no stash, no
  checkout, no reset), the two name lists DIFFED with `playable-set.mjs` so the gain is a SET.
  📏 **THE HONEST SMALLER NUMBERS, three of them:** the row said 432 and contains **no modal work**;
  the bound family estimated 233 and delivered **175**; and **only 28 of the 175 are modal cards**.
  ✅ **Selesnya Charm compiles** (§4a phase 2) — two of its three modes always did; only "Exile target
  creature with power 5 or greater" refused. Also Crushing Canopy, Disdainful Stroke, Valorous Stance,
  Red Elemental Blast, Roast, Abrupt Decay, Despark, Silverquill Charm, Witherbloom Charm.
  🐛 **A shipped refusal was superseded, and is pinned POSITIVELY rather than deleted.**
  `untap-family.test.ts` pinned Norritt as REPORTED for *"a colour narrowing core's restriction union
  cannot express."* Core can express it now. Deleting the pin would leave nothing to fail if the bound
  later stopped being carried, so it is replaced by an assertion that the card compiles carrying
  `{ base: 'creature', bound: { colour: 'U' } }`.
  ⚠️ **A GUARD THE OBVIOUS SOURCE COULD NOT GIVE, and the first draft passed vacuously.** The pre-pass
  is not a row in `EFFECT_RULES`, so `rule-coverage.test.ts` and `dead-rule-sweep.mjs` cannot see it —
  both quantify over the rule table. And `card-index.json` is the SHIPPED POOL, i.e. the cards that
  already compiled, so it contains **ZERO** cards printing four of the five bound families by
  construction: a guard sourced from it goes green while proving nothing. The lines are now
  transcribed verbatim from the corpus with the card that prints each, and the one family the pool CAN
  attest is still checked against the live index so one arm moves when the pool does.
  🐛 **A REAL BUG FOUND BY RE-READING THE CODE, NOT BY A TEST — and the first 29 tests could not see
  it.** `legalTargetsFor` builds a continuous index for the whole menu and passes it down;
  `isLegalTarget` passes nothing. `targetMeetsBound` defaulted a missing index to "no modifications",
  so the two read DIFFERENT power: the menu offered a pumped 2/2 for "power 5 or greater" and the
  cast was then refused — precisely the §3.36 offer/accept disagreement this family's own test claims
  to prevent. **Every test in the file ran on a board with no continuous effect, so all 29 passed
  while the disagreement was live: a check that could not fail.** The parameter now carries the same
  THREE-way distinction `isTargetableBy` uses (undefined = build one; null = this board provably has
  none; an index = use it), with two discriminating tests — a pump entering the bound, a shrink
  leaving it — that both go RED when the fix is reverted.
  🔎 **Red-then-green on FOUR sabotages, all RED:** widen `shadow → flying` in the keyword table (the
  refusal test goes red AND the card compiles — the exact defect the closed table prevents, 1 failed);
  drop the `'or greater'` row from the direction table (**7** failed, Selesnya Charm among them); drop
  the `target` anchor from the bound tail so it also strips GROUP selectors (1 failed);
  restore the layered-stats default (**2** failed, in BOTH directions — a pump that should enter the
  bound and a shrink that should leave it). Restored, 45 green across the two touched files.
  ⚠️ **SEMANTIC-CONFLICT WARNING for the integrator:**
  (1) `packages/core/src/targeting.ts` — the `TargetRestriction` union and **all five of its homes are
  UNTOUCHED** (no new members), so the §3.49 completeness invariant is unaffected and lanes adding
  members (the counters lane added `cardInAnyGraveyard`) do not conflict with this. What changes is
  additive: one contiguous `§3.150` region after `ALL_TARGET_RESTRICTIONS`, plus `isLegalTarget` and
  `legalTargetsFor` gaining a one-line unwrap. The old `isLegalTarget` body is unchanged — it was
  renamed to `baseTargetIsLegal`, so a lane editing that if-chain merges textually.
  (2) **A TYPE WIDENING crosses package lines**: `TargetRestriction` → `TargetSpec` on
  `SpellMode.targets`, `TriggeredAbility.targets`, `StackObject.awaitingTargets`, two `choices.ts`
  `restriction` fields, `restrictionOfEffects`/`targetRestrictionOf`/`describeRestriction`/
  `triggerTargetPrompt`/`spellCopyAimRestriction`, `ai/effect-value.ts` `ModeEffects.targets` and one
  `heuristic.ts` parameter. Any lane that annotates a variable `TargetRestriction` where core now
  returns `TargetSpec` will get a type error, fixed by changing the annotation.
  (3) `packages/cards/src/compile/rules.ts` — the new code is ONE contiguous region at the **tail of
  the file, after `explainUnsupported`**, plus two lines added to each of the two import blocks.
  **No existing rule was edited and nothing above was reformatted**, so the three other live lanes in
  this file should merge cleanly.
  (4) `packages/cards/src/compile/compile.ts` — `applyRules` gains a 6th parameter (`boundApplied`)
  and a ~15-line pre-pass immediately before its final `return null`, directly under §3.149's
  where-X pre-pass. A lane touching that function will conflict there.
  (5) ⚠️ **`apps/web` WAS touched — 6 TYPE-ONLY annotations** in `lib/play/optional-trigger.ts` and
  `lib/play/targeting.ts`. The brief said not to touch `apps/web`; the alternative was a red build,
  and a bounded selector must reach the UI intact or the board offers targets the engine then refuses.
  No behaviour, markup or styling changed.
  ⚠️ **POOL NOT REGENERATED — ON PURPOSE**, per the brief: the local corpus trips a masking defect
  owned by `fix/pool-refresh-3147`. The +175 is the COMPILER's delta on one fixed corpus, measured
  twice. The 175 names are not in `expansion-candidates.json` either.
  ⛔ **Left REPORTED, not approximated, with numbers:** the combat/tap STATE axis (**38 cards** —
  `attackingCreature` is already a union member and a second answer to "is it attacking" is the DRY
  failure rule 12 names); keywords the engine does not model (shadow, horsemanship, fear, intimidate);
  a clause carrying TWO bounded selectors; a P/T or keyword bound on a SPELL (only the card-level
  bounds are read off a stack object); and the rest of the modal row, RE-MEASURED after this lane
  landed: **503 cards, still 1.05 per shape, still MODE-ONLY = 0** (367 BODY + 166 HEADER clauses).
  `modal-blame.mjs` ranks it BY the family that owns it — a rules template 162, filtered-targeting 34
  (nearly halved from 62; this lane took that half), entwine 26, static-buff 25, graveyard 21,
  counters 15.
  ⚠️ **NOT DONE:** no push (worker), no merge, no pool regeneration, no throughput benchmark (the
  change adds one predicate to a menu already filtered, and the continuous index is built once per
  menu rather than per candidate — but that is an argument, not a measurement, and it is not claimed
  as one).
  ⚠️ **§3.150 chosen after scanning EVERY remote head** — §3.149 is already double-claimed on `main`
  (counters and {X} both write `### 3.149`); nothing anywhere claims §3.150.
- 2026-09-15 **WAVE 5 CLAIM + THE COLLISION MAP FOR `compile/rules.ts`** (integrator).
  Three lanes dispatched on the families still blocking Caleb's own decks (ALL-CARDS §4a phase 2,
  §7a is the per-card board): `feat/modal-templates` in `D:/Cool Stuff/Claude/jb-modal` (modal, 432,
  **Selesnya Charm**) · `feat/loyalty-emblem` in `D:/Cool Stuff/Claude/jb-walker` (planeswalker
  loyalty ~300 + emblem, **Jace, Architect of Thought** and **Tamiyo**) · `feat/copy-selectors` in
  `D:/Cool Stuff/Claude/jb-copysel` (copy selector / Populate, 299, **Trostani**). All three forked
  from `fd1ca31`. Three is the cap because this box OOMs above three heavy builds — not a preference.
  ⚠️ **`packages/cards/src/compile/rules.ts` has FIVE live contenders, not three.** Two of them are
  unmerged branches owned by other sessions and are invisible from a worktree cut off `main`:
  | branch | head | `rules.ts` | what else it moves that a card lane needs |
  | --- | --- | --- | --- |
  | `feat/copy-templates` | `c1e2320` | +314 | `copy-primitives.ts`, `core/copy.ts`, `targeting.ts`, `triggers.ts`, `engine.ts` — **the whole copy subsystem `feat/copy-selectors` builds on** |
  | `feat/trigger-body-templates` | `b1ea6c2` | +275 | **`choice-primitives.ts` (new, +115)** — modal mode-selection; **`core/player-statics.ts` (+63)** — the documented EMBLEM seam, which it already reads from the command zone; `card.ts`, `state.ts`, `serialize.ts`, `clone.ts` |
  Both lanes were warned in-flight to diff those branches read-only BEFORE designing, to build on the
  seam rather than a parallel one (rule 12), and to name any shared declaration as a semantic conflict
  rather than resolving it themselves. **A clean textual merge here would not be a working merge** —
  this repo has already had one auto-merge eat three lines of `foldCommandStatics` and another compile
  cleanly with Phyrexian casting dead.
  ⚠️ **Inventory remote heads, not just your own worktrees.** `git branch -r --no-merged origin/main`
  is the check; the two collisions above are both invisible to `git worktree list`.

- 2026-09-15 `feat/counters-templates-v2` — ✅ **pushed-ready, NOT merged** (worker; integrator merges).
  **§3.149 — the counters backlog row measured; it is the §3.120 artifact a THIRD time, and the seam
  inside it is the counter KIND rather than any template.** The row named 2,480 cards. Measured against a
  freshly fetched 32,414-card corpus with NEW `packages/cards/scripts/counters-blame.mjs`: **2,598 template
  clauses across 2,303 distinct shapes — 1.13 clauses per shape**, biggest single shape 12 clauses. Worse
  than §3.147's 1.2. The script splits the row two ways (a closed VERB table, and a probe that rewrites the
  counter kind to `+1/+1` and recompiles); the kind probe is what found the real seam — **207 clauses
  compile the moment the kind is one the engine can hold, of which only 142 may be held HONESTLY.**
  ⚠️ **The refusals are the design.** `INERT_COUNTER_KINDS` is closed: shield (CR 122.1c) and stun (122.1d)
  are the two biggest kinds in the blocked set after ±1/±1 and BOTH keep reporting, because storing a
  counter whose CR rule nothing honours is a card playing weaker than printed.
  Shipped: a `kind` param on `addCounters` (target need not be a creature); `ActivatedAbility.activateOnly`
  (CR 602.5a — a RESTRICTION, never a cost, enforced in `unpayableActivationReason`, the one funnel both
  the legality check and the offer menu read); `TargetRestriction.cardInAnyGraveyard`; the `youLostLife`
  turn fact + `didNotLoseLifeThisTurn`.
  ✅ **Both of Caleb's blocked deck cards compile — Scavenging Ooze and Luminarch Ascension** (§4a phase 2).
  📈 **Accepted-count delta +25, ZERO regressions (6,450 → 6,475)** on ONE fixed corpus compiled twice with
  this lane's nine source files reverted in between; the two name lists are DIFFED, so the gain is a set.
  🐛 **a bare "it" is not a self-reference, and the bug is already shipped on main.** Found by DIFFING the
  two accepted-card lists, not by a test. Free from Flesh ("Target creature gets +2/+2 … Put two oil
  counters on **it**.") first compiled complete as an INSTANT with `self: true`, counters going nowhere.
  ⚠️ **A corpus sweep for the SHAPE found the +1/+1 sibling carrying it on TWO CARDS IN THE SHIPPED POOL —
  Big Play and Miraculous Recovery — and that half is DELIBERATELY LEFT UNFIXED AND PINNED BY A TEST.**
  Applying the one-line gate to `put-counters-on-self` drops both, and `pool-mechanics.test.ts`'s guard is
  absolute by design ("a card dropped from the pool to make a test pass is the failure mode this guards").
  It can only land WITH a pool regeneration — **integrator/pool-refresh lane: add
  `if (!sourceCanHoldCounters(ctx)) return null;` to `put-counters-on-self`, delete the pinning test in
  `named-counters.test.ts`, regenerate; the count falls by exactly 2 and that fall is a correction.**
  📊 `npm run build` **exit 0** · `npx vitest run packages/cards packages/core --minWorkers=1 --maxWorkers=1`
  **19,700 passed, 0 failed / 202 files** (202 collected == 202 `*.test.ts` on disk, 0 skipped,
  no worker exits; exit 0) · `dead-rule-sweep` + a positive corpus count — every new rule FIRES on real cards
  (put-named-counter-on-self **136**, enters-with-named-counters **49**, exile-target-card-from-graveyard
  **49**, activateOnly on exactly the **3** cards that print the shape).
  🔎 **Red-then-green on three rules:** admit `shield` to the inert table → the 2 refusal tests go red AND
  the card compiles `'complete'` (the exact defect the closed table prevents); scope the graveyard exile to
  "your graveyard" → 3 red incl. both deck cards; make the activation restriction never refuse → the
  legality test AND the offer-menu test both go red. Restored, 30 → 33 green.
  📉 **No throughput regression:** `pilot-bench --games 1200`, three runs a side against the same nine files
  reverted — **186/179/206 games/sec vs 186/186/190** (medians identical at 186; this box's spread is
  wider than the difference), and win counts byte-identical at the same seeds (491/483/492) both sides.
  ⚠️ **THE REGENERATED POOL IS NOT IN THIS BRANCH — ON PURPOSE**, for the reason §3.147 gives:
  `fix/pool-refresh-3147` owns it. The +23 is the COMPILER's delta on one fixed corpus, measured twice.
  ⚠️ **SEMANTIC-CONFLICT WARNING for the integrator:**
  (1) `packages/core/src/targeting.ts` gains ONE member (`cardInAnyGraveyard`) at all five homes a
  restriction word has (union, guard alternation, `TARGET_RESTRICTION_MEMBERS`, `isLegalTarget`, the
  enumerator, `describeRestriction`). The activated-ability lane added five members to the same union, so
  expect a textual conflict there — which is the GOOD case; `targeting-completeness.test.ts` fails until
  every home knows the word, and it is green here.
  (2) `packages/core/src/turn-facts.ts` takes bit `1 << 6` — the one the existing comment reserved. A
  second lane landing a fact must take `1 << 7`, or surge/bloodthirst-style cross-talk returns.
  (3) `packages/cards/src/compile/rules.ts` — new rules are ONE contiguous region at the tail of
  `EFFECT_RULES` plus one row in `STATIC_RULES` and one in `INTERVENING_IF_RULES`; nothing above is
  reformatted. The one EXISTING rule touched is `put-counters-on-self` (the bare-"it" gate above).
  ⚠️ **§3.149 chosen after scanning every remote head** — §3.147 is triple-claimed and §3.148 is taken by
  `fix/strionic-ability-copy`; nothing claims §3.149.
  ⛔ **Left REPORTED, not approximated:** shield/stun counters; time/fade/age outside §3.106; loyalty,
  defense, level, lore; keyword counters; "Activate only if AN OPPONENT has …" (5 cards); **counter
  REMOVAL as an activation cost** — `ActivationCost` still has no counter component, which is why
  Grindclock, Surge Node and the whole mana-battery family now PLACE their charge counters and still do
  not enter the pool; proliferate's chooser; "double the number of counters"; every graveyard-exile rider
  that is not "creature card".
- 2026-09-15 `feat/copy-selectors` — ✅ **committed, NOT pushed, NOT merged** (worker; integrator merges).
  **§3.150 — the copy-selector row measured, and the card it "blocks" was never in it.**
  The row named 299 cards and is the §3.120 artifact a FIFTH time, the thinnest yet: **300 cards, 301
  distinct shapes — 1.00 cards per shape** (the five lanes now read 1.20 / 1.18 / 1.13 / 1.08 / 1.00).
  NEW `copysel-blame.mjs` splits it by WHICH HALF has no rule: **SELECTION 32 clauses / 31 shapes,
  FIDELITY 20 / 20, BOTH 7 / 7, SENTENCE 377 / 373, NOT-REWRITABLE 73 / 72** — a row called copy
  *selectors* is **6% selectors and 74% sentences**, its largest single piece the unbuilt verb
  **"becomes a copy of" (72 clauses)**.
  ⚠️ **THE ROW NEVER CONTAINED POPULATE, OR ANY POPULATE CARD.** `UNSUPPORTED_HINTS` is first-match and
  `stripReminderText` runs before any hint is tried, so all **25** printed populate cards are filed under
  **EIGHT other rows** (12 "a rules template", 3 "at the beginning of…", 2 filtered-targeting, 2 "you may
  / choose", and one each graveyard / enters-tapped / delayed-ability / **activated-ability** — that last
  one is Trostani). `--scan` selects by clause TEXT instead of by hint row and reports **691 cards / 712
  clauses against 498 / 509 by hint: 193 cards of this shape sit in other rows.** ⚠️ **This lane moved 34
  cards and the row it was assigned stayed at 300 / 301.** Do not read a row size as a mechanic size.
  Shipped: populate as a resolution-time **CHOICE** selector on `createTokenCopy` (a branch in
  `copySourceFor`, NOT a primitive of its own — it inherits `copiableDefOf`, the doublers, the haste grant
  and the delayed sacrifice); its printed tails through the token-copy family's OWN vocabulary
  (`tokenEntryWords`, `TOKEN_COPY_GRANT_SENTENCE`, `TOKEN_COPY_DELAYED_REMOVAL`); `", then "` as a ROW in
  the shared `compileConjunction` separator table; and `populate` in `PRIMITIVE_BACKED_KEYWORDS` beside
  proliferate.
  📊 **6,653 → 6,687 accepted, +34 gained / 0 LOST**, ONE fixed 32,341-card corpus compiled twice with
  this branch's three sources reverted to fork point `fd1ca31` in between (via `git show`, never a
  checkout). **15 of the 34 are populate cards** (25 printed, 0 → 15 complete); **19 are `", then "`**.
  ✅ **Trostani, Selesnya's Voice compiles and is in the after-set** — the acceptance card.
  📊 `npm run build` **exit 0** (unpiped, dist mtime verified newer than source) · `npx vitest run
  packages/cards packages/core --minWorkers=1 --maxWorkers=1` — see the run line in the report ·
  `dead-rule-sweep` **158 rules · 338 fired · 3 never**, 0 of them naming a corpus card; both new rules
  verified FIRING on real cards (`populate` on 12+ incl. Trostani, `populate-with-token-tail` on Ghired
  and Determined Iteration).
  🔎 **Falsified FOUR times, red pasted in the report**: accepting leftover tail text reddens 2 (the
  over-match — a populate that silently drops its own sacrifice); dropping the printed word "token" from
  the candidate test reddens 2 (the widening — a nontoken Grizzly Bears gets copied); removing the
  post-answer battlefield re-read reddens 1 (the vanished token falls back to the survivor); removing
  `", then "` from the separator table reddens 2. A fifth sabotage was caught by `tsc` instead of a test.
  ⚠️ **ONE EXISTING ASSERTION WAS FALSE AND IS REPLACED, NOT DELETED.** `scry-surveil.test.ts` read
  "REFUSES a scry rider whose tail needs its own chosen target" and passed only because `", then "` was
  not a separator: the SAME card as two sentences, or joined with `" and "`, has compiled to those exact
  two refs since the scry family shipped (verified at the fork point, byte-identical effect lists). It
  pinned a SPELLING, not a compiler property. Replaced with the stronger claim — all three spellings
  compile to a byte-identical effect list. The other red was §3.149's own Trostani tripwire, written to
  fire "the day populate lands"; it now asserts the card has NO blockers.
  ⛔ **Generated files deliberately untouched** (pool, expansion report, card indexes) — the local corpus
  trips a masking defect another live lane owns. No `apps/web` and no `packages/core` changes at all.
  ⚠️ **§3.150 claimed off a contended range** — `main` carried §3.149 at fork and four lanes are live in
  `rules.ts`. Renumber by grepping the number if a second §3.150 appears; this section references no other
  by number except as prose.
  ⚠️ **Semantic-conflict warning for the integrator:** this branch edits `compile/rules.ts` (one bounded
  POPULATE block beside `proliferate`, plus two rows in the shared tail vocabulary near
  `TOKEN_COPY_GRANT_SENTENCE`), `compile/compile.ts` (one row in `PRIMITIVE_BACKED_KEYWORDS`, and
  `compileConjunction`'s local `CONJUNCTION` const becomes a `CLAUSE_SEQUENCERS` table) and
  `copy-primitives.ts` (one branch in `copySourceFor` + two new functions). **Checked read-only against
  `origin/feat/copy-templates` (`c1e2320`): no hunk overlap** — that branch changes `copySpell`, not
  `createTokenCopy`, and its `compile.ts` hunks are at ~32, ~639 and ~1516 while mine are at ~268 and
  ~824. Its residue list does not mention populate, for the hint-order reason above.
  ⛔ **Left REPORTED, not approximated:** **"becomes a copy of" — 72 clauses, a whole printed VERB with no
  rule** (a layer-1 copy applied to a permanent already on the battlefield; CORE work, and this lane
  deliberately did not open `core/src/copy.ts` while `feat/copy-templates` was live in it — it is the
  largest single thing left in this family); the SENTENCE third at large (377 clauses / 373 shapes, 1.01
  each — the §3.120 shape inside the row's own majority); `Populate X times` (Full Flowering — a repeat
  count where `createTokenCopy.count` is a static int); and the ten populate cards blocked by something
  that is NOT populate — Scion of Vitu-Ghazi and Muster the Departed (an intervening "if"), Song of the
  Worldsoul and Arboreal Alliance (a trigger CONDITION), **Cayth, Famed Mechanist (a modal bullet —
  `feat/modal-templates` is live on exactly that)**, Ghired's Belligerence (X damage divided), Xavier Sal
  (a cost removing a counter from another permanent), Selesnya Eulogist (graveyard exile) and Nesting
  Dovehawk (a counters trigger).
- 2026-09-15 `feat/targeted-trigger-templates` — ✅ **pushed-ready, NOT merged** (worker; integrator merges).
  **§3.148 — the targeted-trigger row measured, split THREE ways, and a card already in the pool that
  played better than printed.** The row named 888 cards and is the §3.120 artifact again (884 cards,
  748 shapes, 1.18 cards each). NEW `targeted-blame.mjs` splits it by WHICH OF THREE halves fails —
  and unlike §3.147's row it does **not** collapse into one: **BODY 396 clauses / 254 shapes,
  SELECTOR 137 / 99, TRIGGER 97 / 60.** Three closed-table shapes shipped: the body's leading PRONOUN
  ("it deals N damage to …", the row's largest one-clause shape at 15 cards), "creature an opponent
  controls" as a row in four noun tables, and the O-Ring's LINK.
  📊 `npm run build` **exit 0** (unpiped) · `npx vitest run packages/cards packages/core
  --minWorkers=1 --maxWorkers=1` ****19,682 passed, 0 failed / 202 files**** (202 files collected == 202 `*.test.ts` on disk,
  0 skipped, no "Worker exited unexpectedly") ·
  every rule this branch added or widened FIRES on real corpus cards:
  `trigger-etb-exile-target-noun-linked` 4 (Journey to Nowhere, Faceless Butcher, Petravark, Oblivion
  Ring), `damage-any-target` 245, `pump-until-eot` 255, `tap-target-noun` 20,
  `return-target-permanent-to-hand` 78 ·
  **red-then-green ×3**, each sabotage reddening exactly the intended test: drop the `watches` check
  in `resolveSourcePronoun` → the equipped-creature card compiles (1 red); drop `(another )?` from the
  linked-exile pattern → Oblivion Ring stops compiling (2 files red); drop `printsLinkedReturn` →
  Galactus's plain exile becomes a linked one (1 red).
  📈 **Compiler delta +122 accepted (6,450 → 6,572), 0 lost, on one fixed 32,414-card corpus** — the
  same corpus compiled twice with this branch's `rules.ts` reverted in between (`git show
  origin/main:…` + a file copy; **never `git stash`**), so the number is the compiler's and not a
  corpus refresh's. **Oblivion Ring ✅ and Faceless Butcher ✅ compile** — `docs/decks/thunes-life.txt`
  loses one ✗. The row went 884 → 780 cards.
  ⚠️ **A DEFECT IN THE SHIPPED POOL, NOT A NEW FEATURE.** `exile target creature` compiled to a bare
  `exileTarget`, which records no link, beside a `returnExiledByThis` that returns only what the link
  names — so **Journey to Nowhere and Petravark shipped in `expanded-pool.ts` as one-way exiles whose
  own printed second line gave back nothing**: removal with no drawback. `compile.test.ts` and
  `fidelity.test.ts` went red on exactly those two cards, correctly. **`data/expanded-pool.ts` carries
  a TWO-LINE splice** (the two stale `effects:` lines), values written by a script from the compiler's
  own output — those two ground-truth tests are the check that the splice is right. The integrator
  still owes a full `build-expansion.ts` regeneration; this is the minimum that keeps the branch green
  without committing another lane's corpus refresh.
  ⚠️ **SEMANTIC-CONFLICT WARNING — `packages/cards/src/compile/rules.ts` only** (no `packages/core`
  change, no `apps/web` change, so the counters and {X} lanes should merge cleanly around it):
  (1) four closed tables each gain ONE row — `TARGET_NOUN_RESTRICTIONS`, `PUMP_TARGET_NOUNS`,
  `UNTAP_TARGET_NOUNS`, `DAMAGE_TARGET_RESTRICTIONS` (`'creature an opponent controls'`);
  (2) `return-target-permanent-to-hand` swaps its private `(creature|permanent)` alternation for
  `TARGET_NOUN_PHRASE` — a lane that added a noun row gets it on bounce for free, which is the point;
  (3) NEW contiguous region before `EFFECT_RULES` (`RETURN_EXILED_TO_BATTLEFIELD`,
  `RETURN_EXILED_TO_HAND`, `LEAVES_TRIGGER_PREFIX`, `printsLinkedReturn`) and the two
  `return-exiled-by-this-*` rules now name those constants instead of inlining their patterns;
  (4) NEW contiguous region before `triggerFrom` (`SOURCE_SUBJECT_EVENTS`, `resolveSourcePronoun`),
  one changed line inside `triggerFrom` and two inside `optionalTriggerFrom`;
  (5) NEW rule `trigger-etb-exile-target-noun-linked`, immediately above `trigger-etb`. **ORDER IS
  LOAD-BEARING** — below `trigger-etb` it never matches and Oblivion Ring silently regresses to a
  drawback-free exile.
  ℹ️ **Two findings worth carrying, both about how a row is READ:**
  (a) **`UNSUPPORTED_HINTS` is FIRST-MATCH, so a row's boundary is hint ORDER, not meaning.**
  `/leaves the battlefield/` sits above the targeted-trigger entry, so all 68 printed *"exile target X
  until this leaves the battlefield"* lines are filed under a different row while being this shape.
  (b) **A "REFUSES …" assertion can be a check that cannot fail.** The first version of the
  host-watch test used an Equipment with no `Equip {N}` line: the compiler refused it for THAT reason
  and the assertion passed under every sabotage. Fixed by printing the Equip line and asserting the
  REASON, not just the verdict. The board-watching sibling assertion is now labelled honestly as a
  card regression guard rather than a table falsification — `trigger-permanent-enters-or-dies` calls
  `ctx.compileTriggerBody` directly and never asks `triggerFrom` what "it" means.
  ℹ️ **Left REPORTED, each with its number:** the modern O-Ring `exile target <NOUN> an opponent
  controls until ~ leaves the battlefield` — **21 lines `nonland permanent`, 6 `artifact or creature`,
  3 `tapped creature`, 3 `creature or planeswalker`**, all needing a NEW `TargetRestriction` member at
  the five homes a restriction word has (§3.40); this lane deliberately did not open core's union with
  three lanes live in `rules.ts`, and that is the cheapest remaining work in this family. Also Frost
  Lynx's `tap target X. THAT creature doesn't untap…` (8 clauses — a two-aim body
  `compileTriggerBody` refuses on purpose), and the trigger-condition third at large (79 shapes over
  129 clauses after this branch, top shape `when ~ is turned face up` at 14 — the §3.120 shape again).
- 2026-09-15 `feat/xvalue-templates` — ✅ **pushed-ready, NOT merged** (worker; integrator merges).
  **§3.149 — the {X}/derived-value row measured, and its NAME points at the wrong half.**
  The row named 953 cards and is the §3.120 artifact a THIRD time: **954 cards, 973 clauses, 880 shapes —
  1.08 cards per shape**, thinner than §3.147's 1.2. NEW `xvalue-blame.mjs` splits it by WHICH HALF has no
  rule and shows the amount vocabulary was never most of it: **SENTENCE gap 683 clauses / 574 shapes against
  AMOUNT-only 170 / 155** — 70% of the row is an effect the table cannot build, filed here only because its
  text contains "equal to". NEW `xvalue-families.mjs` ranks the amount half by CARDS unblocked. Four closed
  tables shipped: `{X}` in an ACTIVATION cost (`ActivationCost.xCost`, value on the action, offer path
  enumerates one per affordable value), object-characteristic amounts at the one `intParam` seam, the
  GENERAL "where X is …" binding as one pre-pass in `applyRules`, and a FILTERED count row
  (`countPermanentsMatching`) so the next printed noun is a table row instead of a core enum row.
  📊 **6,443 → 6,500 accepted, +57 gained / 0 LOST**, one fixed 32,341-card corpus compiled twice with this
  branch's sources reverted to fork point `51919f7` in between. Row 954 → 921 cards, 880 → 850 shapes.
  ⚠️ **THE FIRST SET DIFF WAS +55 WITH 8 SILENT LOSSES** — generated count rows were spread after the named
  ones, so "lands you control" stopped being the row core's CDA evaluator knows and Molimo, Maro-Sorcerer
  plus seven siblings left the pool with every test green. `playable-set.mjs` is what caught it; a bare
  count would have reported it as a win. Named rows now win and a test pins the precedence.
  📊 `npm run build` **exit 0** (unpiped) · `npx vitest run packages/cards packages/core --minWorkers=1
  --maxWorkers=1` — see the run line in the report · `dead-rule-sweep` **154 rules · 332 fired · 3 never**,
  all three dead on `main` before this branch; `object-characteristic-draw` was dead when written and the
  sweep caught it, so the third "its"-seam was opened and Gregor, Shrewd Magistrate compiles.
  🔎 **Falsified two new rules, red pasted in the report**: removing the `xIsBound` gate reddens exactly 1
  test (X accepted where nothing bound one); never setting `carriesSubject` reddens exactly 2 (Trostani
  reads nothing, AND the dies-trigger lock stops firing) — the silent-zero defect, which is the failure
  mode of an amount vocabulary.
  📏 **Throughput paired on one box**, `pilot-bench --games 1200 --seed 4242`, 5 reps before / 9 after:
  **median 195 vs 207 games/sec**, ranges 170–199 and 179–221, overlapping. All 14 runs played identical
  games (`A won 504/1200`), and `derived.ts`'s diff is purely additive — `evaluateDerivedCount`'s switch
  and `characteristicValue` are byte-identical to `main`, so the stat-read hot path cannot have moved.
  ✅ **Kessig Wolf Run compiles.** ❌ **Trostani, Selesnya's Voice does NOT, and not for this family's
  reason**: its trigger compiles; `{1}{G}{W}, {T}: Populate.` blocks it — `createTokenCopy` has `self`,
  `equipped` and TARGET selectors and populate is a resolution-time CHOICE among your creature tokens.
  **That belongs to the copy-selector family (§3's 299-card near-miss row), and a test pins the residue.**
  ❌ **Axebane Guardian NOT made reachable and not attempted** — §3.147's reason stands and nothing here
  touches the mana system. Its easier sibling ("Add an amount of {G} equal to ~'s power" — Marwyn,
  Viridian Joiner) is left REPORTED for the same reason.
  ⛔ **Generated files deliberately untouched** (pool, expansion report, card indexes) per §3.147's finding.
  ⚠️ **§3.149 claimed off a contended range** — §3.148 is in `main` AND on `fix/strionic-ability-copy`.
  Nothing claims §3.149 (remote scan). The number is a CROSS-FILE identifier: **35 references across 11
  source files**. Renumber by grepping the number, not by editing the heading.
  ⚠️ **Semantic-conflict warning for the integrator:** this branch edits `compile/rules.ts`,
  `compile/compile.ts`, `compile/text.ts`, `compile/types.ts` and `effect-helpers.ts` alongside the
  counters and targeted-trigger lanes. The riskiest hunks are **`applyRules`** (a new binding pre-pass at
  the end), **`DERIVED_COUNTS`** (split into a NAMED and a FILTERED half whose spread ORDER is
  load-bearing), and **`RuleContext`** (two new optional fields). A clean textual merge of
  `DERIVED_COUNTS` that reorders the two spreads silently costs 8 cards — re-run `playable-set.mjs` as a
  SET DIFF after merging, not a count.
  ⚠️ **A DRY duplicate left in place on purpose:** `damage-any-target` and `x-damage` are one sentence
  written twice. Merging them deletes `x-damage`, which `apps/web/src/lib/about/mechanics.ts` names as the
  {X} mechanic's WITNESS with a test that fails when a witness stops resolving — a two-file fix this lane
  does not own. Both rules carry a note. Also untouched: `each-opponent-loses-life` is declared TWICE in
  `EFFECT_RULES` with the same `id` (pre-existing), so coverage tooling cannot tell the two apart.
- 2026-09-14 `feat/activated-ability-templates` — ✅ **pushed-ready, NOT merged** (worker; integrator merges).
  **§3.147 — the activated-ability backlog row measured, then the one shape inside it that concentrates.**
  The row named 1,449 cards and is the §3.120 artifact again (1,273 distinct shapes, 1.2 cards each); NEW
  `activated-blame.mjs` splits it by WHICH HALF fails and shows the cost vocabulary was never the
  bottleneck — **BODY 1,134 clauses / 912 shapes against COST 71 / 48.** NEW `activated-families.mjs`
  ranks the survivors by cards unblocked. Three closed tables shipped: the damage SHIELD (114 clauses,
  the largest printed body in the row), the UNTAP family (+ five basic-land-type restrictions in core),
  and the wall-tribal derived count.
  📊 `npm run build` **exit 0** · `npx vitest run packages/cards packages/core --minWorkers=1 --maxWorkers=1`
  ****19,667 passed, 0 failed / 200 files**** (200 files collected == 200 `*.test.ts` on disk, 0 skipped, no worker exits) ·
  card-index `--check` up to date · `dead-rule-sweep` — every new rule FIRES on real corpus cards
  (untap-self 54, untap-target-noun 38, tap-target-noun 20, prevent-next-damage-targeted 60,
  prevent-next-damage-fixed-recipient 10, target-player-mills-where-x 3) ·
  red-then-green on both families (widen `'forest'` to `isLand()` → 3 red incl. the targeting-completeness
  offer/legality sweep; drop the shield's `amount` → 4 red).
  📉 **No throughput regression:** `sim match "Mono-Red Aggro" "Boros Aggro" --games 150 --seed 909
  --workers 1` — 141/145/151 games/sec on this branch against 143/151/144 with the five source files
  reverted (means 146 vs 146, this box's own spread is wider), and `Mono-Red Aggro 53/150` is identical
  on both, which is the like-for-like proof.
  📈 **Compiler delta +106 accepted (6,305 → 6,411) on one fixed 32,341-card corpus**, the same corpus
  compiled twice with this branch's five source files reverted in between, so the number is the
  compiler's and not a corpus refresh's. Arbor Elf ✅ and Doorkeeper ✅ compile; **Axebane Guardian does
  not** and a test pins why (`ManaAbility.produces` is a fixed mode list indexed by `TapForManaAction.mode`;
  "X mana in any combination of colors" is a multiset choice whose size moves with the board).
  ⚠️ **THE REGENERATED POOL IS NOT IN THIS BRANCH — ON PURPOSE. `fix/pool-refresh-3147` OWNS IT.** The only
  corpus here is 65 cards newer than the one the committed pool came from and is worth **+686 on its own,
  before this compiler touches anything**. Measured soak (`soak --games 120 --seed 4242 --workers 1`):
  main pool + main compiler **0 violations**; refreshed pool + **main** compiler **244**; refreshed pool +
  this compiler **304** — all 304 on ONE check ("no card in a hidden zone leaks into an observation") with
  the same six leaking matchups either way, i.e. the pre-existing masking defect that lane already took
  from 754 to 4, reached more often by a bigger pool. **Integrator: merge the pool-refresh lane FIRST,
  then re-run `npx tsx packages/cards/scripts/build-expansion.ts` + `npm run fetch -w @jonny-boi/data-tools
  -- --corpus <corpus> --no-art` + `node apps/web/scripts/build-card-index.mjs` — offline and idempotent.
  Until that runs the +106 is correct, tested, and NOT on a screen.**
  ⚠️ **SEMANTIC-CONFLICT WARNING — three shared files carry additive changes:**
  (1) `packages/core/src/targeting.ts` — `TargetRestriction` gains five members (`plains`…`forest`) driven off
  one new `BASIC_LAND_TYPE_SUBTYPE` table at all five homes a restriction word has. A lane adding a member
  will conflict TEXTUALLY in the union, the validator, `isLegalTarget`, the enumerator, `describeRestriction`
  and `TARGET_RESTRICTION_MEMBERS` — which is the good case; `targeting-completeness.test.ts` fails until
  every home knows the word, and its zoo gained an all-five-types land to feed the new members.
  (2) `packages/core/src/card.ts` + `derived.ts` — `DerivedCountName` gains
  `creaturesYouControlWithDefender` plus its evaluator case.
  (3) `packages/cards/src/primitives.ts` — two new primitives (`untapTarget`, `untapSelf`) in the registry
  list, and `preventDamage` gains a `selfShield` param.
  ℹ️ **Left REPORTED, each with its reason in §3.147:** "untap ANOTHER target permanent" (an
  `ActivatedAbility` cannot carry the exclusion — the only writable rule drops the word and hands Kiora's
  Follower an untap loop); the whole `Activate only …` wrapper (47 cards whose bodies already compile, but
  27 of its 29 spellings are board CONDITIONS this engine cannot check, and the two real windows need a
  third timing value `CastTiming` cannot carry); the general `where X is …` binding (measured FIRST — 83
  cards over 74 distinct bodies, top body 4 cards, so only the one body carrying Doorkeeper was written).
- 2026-09-14 `fix/builtin-deck-identity` — ✅ **pushed-ready, NOT merged** (worker; integrator merges).
  **A built-in gauntlet deck must not look like one of yours** (DESIGN §3.147). The report was *"I renamed
  the Selesnya Blink deck to Acidic Angels, which apparently just DUPLICATED the deck"* — nothing duplicated;
  the built-in list was deliberately styled to look like the user's own decks and `gauntlet-decks.css` said so
  in its own header. Reversed on every deck-listing surface from ONE closed table, `lib/decklist/deckOrigin.ts`.
  📊 `npm run build` **exit 0** · `npx vitest run apps/web --minWorkers=1 --maxWorkers=1` **1,995 passed, 0 failed
  / 151 files** (== 151 `*.test.ts` on disk, 0 skipped) · `verify-board-fits` **32/32 exit 0** · new
  `verify-deck-identity` **36/36 exit 0** (desktop 1440 + phone 375; PNGs in `apps/web/verify-out/deck-identity/`).
  ⚠️ **§3.147 IS CLAIMED OFF A CONTENDED RANGE.** §3.146 was the highest in `main` at fork. If a second §3.147
  lands, renumber mine — it references nothing by number.
  ⚠️ **SEMANTIC-CONFLICT WARNINGS FOR THE INTEGRATOR:**
  (1) **`apps/web/src/lib/online/deck-menu.ts` is DELETED.** It was a second copy of `SetupScreen.tsx`'s private
  `buildMenu` — two places answering one question, which is how the two surfaces came to label built-in decks
  differently. Both consumers now read `lib/decklist/deckMenu.ts`; its test moved to `decklist/deckMenu.test.ts`.
  A lane importing the old path will fail to COMPILE, which is the good case.
  (2) **`apps/web/src/views/gauntlet-decks.css` is DELETED**, replaced by `views/builtin-decks.css` +
  `components/deck-origin.css`. Class names `.gauntlet-deck*` are gone; a lane styling them paints nothing.
  (3) `Deck` gains optional `copiedFrom`, and `storage.ts`'s `normalizeDeck` lists it — that function REBUILDS
  field by field, so any lane adding a `Deck` field must add it there too or lose it on every reload.
  (4) `DeckBuilderView.tsx` now EXPORTS `GauntletDecks` and `SavedDecks` (for the identity guard), and `SavedDecks`
  renders unconditionally — it used to hide itself at `decks.length <= 1`, which left a lone column of built-ins.
  ℹ️ **Not done, deliberately:** the Lab's hero picker already grouped by origin (`isGauntletDeckId`) and was left
  alone; it is the one surface that never had the ambiguity. The full workspace suite was NOT run (6-core/7 GB box,
  per the brief) — `packages/*` are untouched, but the integrator should run the whole gate.
- 2026-09-14 `fix/announce-forced-choice` — ✅ **pushed-ready, NOT merged** (worker; integrator merges).
  **Two reports, one mechanism** (§12 of `docs/MTGA-UX-OVERHAUL.md`): a choice the engine settles
  because it had exactly one legal answer is now ANNOUNCED naming the card it chose, and UX-16's
  opponent-spell hold now shows the held spell's TARGETS.
  📊 `npm run build` **exit 0** · `npx vitest run apps/web packages/core` **3283 passed, 0 failed / 242 files**
  · harnesses `verify-combat-visibility` **6/6**, `verify-board-fits` **32/32**, new `verify-forced-choice` **12/12**
  (both reports photographed; PNGs in `apps/web/verify-out/forced-choice/`).
  ⚠️ **SEMANTIC-CONFLICT WARNING FOR THE INTEGRATOR — four shared files carry additive changes:**
  (1) `packages/core/src/events.ts` — `choiceAutoAnswered` gains `sourceInstanceId` + `sourceName`, and all
  SEVEN emit sites in `engine.ts`/`effects.ts` set them. A lane that ADDS an eighth emit site will fail to
  compile until it does too — which is the point, not a conflict.
  (2) `packages/core/src/instance-ids.ts` — one row extended (compile-enforced, so a bad merge cannot be silent).
  (3) `packages/core/src/choices.ts` — `CHOICE_KINDS` + a completeness witness added; no behaviour touched.
  (4) `apps/web/src/lib/play/proposal.ts` — `ASK_WHEN_ONLY_ONE_ANSWER` is now `AUTO_SETTLE_POLICY`, a
  discriminated union. A lane holding the old name will conflict TEXTUALLY, which is the good case.
  ℹ️ Also: `StackTargetRow` moved out of `StackPanel.tsx` into the new `CardReferences.tsx`, and its CSS moved
  out of `stack-panel.css` into `card-references.css` (unscoped, same class names). A lane touching either file
  should take BOTH sides.
  ℹ️ **Not done, deliberately:** the ONLINE board gets the log line only. `@jonny-boi/protocol` carries masked
  state, not `GameEvent`s, so `OnlineBoard` cannot see a `choiceAutoAnswered`; the banner and the decision are
  board-agnostic and ready for whatever `feat/online-event-stream` lands.
- 2026-09-13 supervisor: ✅ **MERGED to `main` (PR #17, `d1c3b23`) — `feat/mtga-ux-3143`, thirteen commits, fifteen of seventeen items done, two partial.**
  📊 Gate on the MERGED tree: **22,564 passed / 442 files, 0 failed**, lint 0 errors, card-index up to date, and all four
  browser harnesses at contract (board-fits 32/32, mana-choice 19/19, game-resume 18/18, bug-reporter 31/31).
  ⚠️ **TWO MERGES WITH `main` EACH HID A SILENT LOSS, and neither would have failed a test — worth knowing before the next
  four-way collision.** (1) In `internal/continuous.ts`, git's OWN auto-merge — the part that reported no conflict — ate three
  lines of main's `foldCommandStatics` body by aligning `applied = true;` as a common line; emblem anthems would have applied
  nothing. (2) In `PlayBoard.tsx`, main's new Phyrexian `phyrexianLife` argument was passed by the exact call site this branch
  deleted, so `dispatchOpening` called `castWithAutoTap` with four arguments instead of five: **the merge compiled cleanly with
  casting-for-life dead.** Both were found by tracing a value to the engine, not by trusting the build. When a branch REPLACES a
  mechanism that upstream has since EXTENDED, diff the argument lists by hand.
  ℹ️ Both branches had also independently invented `readsEffectiveStats` / `readsSettledStats` for one question. Main's kept,
  mine deleted — one vocabulary, per rule 12.
  Original push entry: ** `feat/mtga-ux-3143` — eight commits, fifteen of seventeen items done, two partial.**
  Scope + the per-item checklist: **[docs/MTGA-UX-OVERHAUL.md](docs/MTGA-UX-OVERHAUL.md)**; status in DESIGN §3.143.
  📊 **Gate: build clean, 22,467 passed / 435 files, lint 0 errors, card-index up to date, and all four browser
  harnesses AT CONTRACT — board-fits 32/32, mana-choice 19/19, game-resume 18/18, bug-reporter 31/31.** Sim
  throughput 236 games/sec vs main's 239 over ten interleaved runs (~1.3%, inside this box's 6-7% spread; `A won
  845/2000` identical on every run proves like-for-like).
  ⚠️ **THE LESSON WORTH CARRYING: the dominant failure here was BUILT, TESTED, GREEN AND UNREACHABLE.** Six
  times: `proposal.ts` imported by nothing; a provenance tooltip clipped by three `overflow` ancestors that had
  never once rendered; a 3D tabletop shipped at 8° with `transform-style: flat` (cos(8°)=0.99 — nothing) that
  passed every structural test; `AbilityPrompts.tsx` rendering bare strings that no lane owned; three class names
  with zero CSS; a prop no call site passed. **Not one was caught by a test.** Every one was caught by running a
  browser harness or opening a PNG. A 42 MB DOM on the card browser (5,651 tiles × 7.4 KB of expanded `style`)
  survived 22,000 tests because **`renderToStaticMarkup` does not expand the `all` shorthand** — SSR sees 30
  characters where a browser produces 7,414.
  ➡️ **So: run `apps/web/scripts/verify-*.mjs` one at a time and LOOK at the screenshots before calling any UI
  work done.** Write guards about REACH, not shape — the three that worked were "every imported symbol is also
  called", a closed table of mount sites, and a real `renderToStaticMarkup` board mount.
  📌 **STILL OPEN, stated rather than rounded up:** UX-2 and UX-10 partial (details in §7.1); UX-13 and UX-15
  never observed (the combat rig reached declared attackers, not blockers); battlefield tiles still smaller than
  hand cards (inverted hierarchy vs MTGA); a turned card's badge and name run vertically; the phone battlefield
  strip is ~13px (pre-existing, needs SeatPanel's rail restructured).
  ℹ️ The primary checkout was **83 commits behind `origin/main`** at the start, with a staged pile of
  already-merged wave-2 work; snapshotted to `backup/pre-sync-20260911` and reset before any work began.

- 2026-09-11 worker (feat/block-selectors-effective-pt): ⚠️ **FOUR LIVE BRANCHES ALL CLAIMED DESIGN §3.143 — I MOVED TO §3.146; THREE STILL COLLIDE.** Scanned every remote head's `DESIGN.md` for a §3.143–§3.159 heading. Four branches write a `### 3.143`, and **nothing anywhere claims §3.144–§3.159**, so the numbers are free and the fix is mechanical. By the order their tips were pushed: **`feat/mtga-ux-3143`** (18:20, "The MTGA-parity play surface") — the strongest claim, since the number is in its BRANCH NAME; **`fix/honest-test-registry`** (18:36, "The fixture that could not fail"); **`feat/phyrexian-hybrid-mana`** (19:08, "Phyrexian and monocolour hybrid mana"); and this branch, which has already renumbered itself **§3.143 → §3.146** so nobody has to move on my account. Suggested deterministic assignment for the other three, by push order: mtga-ux keeps **3.143**, honest-test-registry takes **3.144**, phyrexian-hybrid-mana takes **3.145**. ⚠️ **A section number is a CROSS-FILE identifier, not just a heading** — mine appeared in eleven places across `DESIGN.md`, `COORDINATION.md`, two source files, three test files and a bench, and a renumber that fixes only the heading leaves every doc-comment pointing at somebody else's feature. Rename by grepping the number, not by editing the heading. 🔎 **The re-runnable check, for whoever integrates:** `for b in $(git ls-remote --heads origin | awk '{print $2}' | sed 's|refs/heads/||'); do git show "origin/$b:DESIGN.md" | grep -o '^### 3\\.1[0-9][0-9]' | sort -u; done` — the collision is invisible from inside any single worktree, which is why all four of us took the same number.
- 2026-09-11 worker (feat/block-selectors-effective-pt): ✅ **SHIPPED: a block bound the card does not print, and a SHIPPED defect in the pass that makes it possible (§3.146).** ⚠️ **READ THE SECOND PARAGRAPH BEFORE THE FIRST.** 🐛 **`aggregateFor` IGNORED THE SETTLED-STATS BOUNDS ENTIRELY, ON MAIN, SINCE `f03d7f8`.** It is the single-instance twin of `indexContinuous` and a live production path — the engine's granted-ability lookup, `protection.ts`, `intervening.ts`, `triggers-runtime.ts`, the pilot's board reads, four primitives — and it folded such a static UNCONDITIONALLY, because `staticAppliesTo` does not read the effective bounds. **Tetsuko Umezawa made a 4/4 unblockable through that path** while the index path got it right: two answers to one question, and the file's own comment three lines above warns about exactly that failure for emblems. The old `indexContinuous and aggregateFor give the same answer` test could not see it because **its board carried a plain anthem**, which has no bound to ignore; the replacement is a TABLE with one row per deferring field. `foldCommandStatics` (emblems) got the same fix. ✅ **THE FEATURE:** Champion of Lambholt — "creatures with power **less than this creature's power** can't block creatures you control" — deferred by name in both §3.17 and §3.25 as "a restriction whose threshold is ANOTHER permanent's power". **THE LAYER OPTION TAKEN, and why none of the three in the brief was needed:** `indexContinuous` already runs a SETTLED pass after every P/T layer for selectors that read effective P/T, and every static in it may grant **KEYWORDS ONLY** — so §3.146 just extends that pass from a selector to a granted BOUND (`StaticAbility.blockBoundFromSourcePower`). **The loop-absence proof is one sentence: the pass reads POWERS and writes KEYWORDS, and nothing that produces a power reads a keyword** — so its output can never be its own input, one pass IS the fixpoint, and two creatures reading each other terminate because there is nothing to order, not because a cap stopped them. A bounded fixpoint would have been a cap over a loop that does not exist. It is proved **executably** (the test runs iteration two by hand off the index's own output and demands the same numbers, on a board of two mutually-reading bounds under an anthem) and **structurally** on the single-instance path (`aggregateFor` → `aggregateWith(state, id, runSettledPass)`; a bound reads its source with the pass switched OFF, so the recursion is one level deep by construction). ⚠️ `staticIsInert` had to learn the new field or a Champion-shaped static — no keywords, no P/T delta — is judged inert and skipped **before it is ever deferred**: compiling `'complete'` and doing nothing. **The pilot got ZERO new code, deliberately** — `chooseBlock` already ends at core's `illegalBlockDeclaration` and `canBlockByEvasion` is a one-line delegation, so the sixth printing of "the pilot re-implements a core blocking rule and drops a clause" is not available to be written. 📊 **725 → 726/2100 as a SET DIFF — one name gained (Champion of Lambholt), ZERO lost.** One card, reported as one card: the row's "16 cards" is a coverage-audit CATCH-ALL — every unmatched clause mentioning blocking gets the same `system` string — and probed individually the sixteen are sixteen different gaps, only one of which is this shape. 📏 **Throughput paired against a same-box `origin/main` worktree with `process.cpuUsage`** (`packages/core/bench/settled-static-cost.ts`, three arms interleaved, best-of-5). The board every gauntlet game has is **at parity**: `aggregateFor` 103 ns both sides exactly, `indexContinuous` 940 (main) vs 780 (branch) for *identical code*, which is the box variance the pairing exists to expose. The **CONTROL arm** — an ordinary keyword-granting static, code main has too — agrees to 0.9% (6,197 vs 6,250 ns), and the feature's own cost is **+12% over a keyword-granting static of the same reach** (6,977 ns), one extra battlefield walk, paid only while such a card is in play. ⚠️ The bench states that running its Champion arm on main measures NOTHING (the field does not exist; the static is inert there). **Gauntlet seed 99 byte-identical: 97/320 = 30.3%, rows 17·14·19·7·8·10·17·5.** 🔎 **11 sabotages, 11 RED, 0 escapes — and the FIRST run of that battery proved nothing.** The suite was already red: `indestructible-and-blocking.test.ts`'s "STILL reports the restrictions this engine cannot express" probe **named Champion of Lambholt and went stale the moment it compiled**, so every mutation reported RED and the pass reported 10/10 while checking nothing. The battery now asks whether the baseline is green and refuses to run if it is not — **a sabotage pass against an unverified baseline is exactly the "check that reports something other than *I did not check*" shape.** The probe now names the shapes genuinely still refused. ⛔ **DELIBERATELY NOT BUILT, each with the number that decided it** (full table in §3.146): **the filtered target** (Access Tunnel, Escape Tunnel — "target creature with power N or less") is the biggest thing left in this bucket at **2 whole cards**, and it is a `TargetRestriction` refactor, not a blocking feature — that union is a flat string with **92 `restriction ===` sites in `targeting.ts` alone**, so a member per N is not a row; its own type comment names this boundary and the second card needing it has now landed. **Void Winnower's** block half is a `CardFilter` parity field away but its other line needs a cast-restriction static core does not have at all (**zero** `cantCast`/`castRestriction` symbols). **The quoted token ability** (`"This token can't block."`, 4 cards) was PROTOTYPED AND MEASURED at **+0 cards** and reverted: it un-blocks that clause for Lord Skitter and Skrelv's Hive but both keep a second unrelated gap, and Song of Totentanz also needs `splitSentences` to treat a quoted sentence's closing period as a boundary — pool-wide, with a sibling live on token copies. **Archangel of Tithes** is a COST to block, which CR 509.1 has no room for; **Fighter Class** is a targeted per-combat requirement; **Odric** and **Lord of the Accursed** are mass keyword grants, not block selectors. ✅ `npx vitest run` **21,818 passed / 0 failed**; `npm run verify` exit 0; `npm run build` exit 0.
- 2026-09-11 worker (feat/phyrexian-hybrid-mana): ✅ **SHIPPED: Phyrexian `{W/P}` and monocolour hybrid `{2/W}` — one symbol shape, three families (§3.143).** A hybrid symbol was a list of COLOURS; it is now a list of **components** (a colour, a `{generic:n}`, or a `{life:n}`), so `{G/W}`, `{2/W}`, `{W/P}` and even `{G/U/P}` are ONE structure with one answer each for mana value, colour identity, rendering and payment. Widening the ELEMENT rather than adding two more fields is the whole design — three parallel fields would have meant four readers each learning three shapes. 📊 **SET DIFF, cached 2100-card corpus: 722 → 725, three gained (Dismember, Gut Shot, Phyrexian Metamorph), ZERO lost.** 📏 **THE HONEST SMALLER NUMBER: the row said 8 cards; the measurement says 3.** All 8 print Phyrexian and **none of the 2,100 prints a monocolour hybrid at all**; of the 8, only 3 are blocked by the symbol ALONE — the other five each need a *different* named system (Noxious Revival a graveyard template, Tezzeret's Gambit a proliferate tail, K'rrik "for each {B} in a cost, you may pay 2 life", Vraska the Compleated keyword + two loyalty templates, Norn's Annex an attack tax that spends `{W/P}`). Monocolour hybrid ships anyway because it is the same three lines as the family beside it, but **it unblocked 0 measured cards** and that is the number. ⚠️ **THE TRAP THE BRIEF NAMED, and it is real: the card-index invariant.** `data-tools`'s `checkCard` bracketed mana value as `known .. known + other.length` — **at most ONE pip per unattributed symbol** — so Flame Javelin's printed 6 sat outside a bracket allowing 3 and the first `{2/R}` card to reach the index would have failed an invariant several systems from the mistake. CR 202.3b makes a hybrid symbol worth its GREATEST component (`{2/W}` = 2, `{W/P}` = 1 *however it was paid*, CR 202.3c). The bracket now reads `maxSymbolManaValue` — a SECOND answer to "what is a printed symbol worth?", unavoidable because data-tools deliberately has no dependencies and cannot call core — so NEW `mana-value-parity.test.ts` fails when the two disagree, **and checks both against Scryfall's own `cmc` over the whole card index**, because a table agreeing with itself proves nothing if both halves are wrong. 🎯 **THE DESIGN DECISION WORTH KNOWING: the Phyrexian life rides the cast ACTION, not a parked cast-time question.** A Phyrexian symbol is part of the BASE cost, and `applyCastSpell` charges the base cost *before* the spell reaches the stack and before `askNextCastChoice` runs — a question asked afterwards would be answering for mana already out of the pool. So `CastSpellAction.phyrexianLife` (omitted when 0, exactly like `face`/`fromZone`/`alternative`) and `pushCastOffers` emits **one cast per fundable life amount**. That is §3.19's MADNESS seam, for the same reason it was right there: every seat already enumerates actions and submits one, so this needed **no new choice kind** — and therefore no row in `KIND_NOUNS`, no eight switches in `choices.ts`, no `CHOICE_ANSWER_ID_FIELDS` entry, no protocol change. Three rules keep it exact: `phyrexianLifeOptions(cost, life)` is the CLOSED ascending list capped by the LIVE total (CR 118.4 — paying to exactly zero is legal, the player's call, and promptly lethal, so the cap is `life`, not `life-1`); `canPay`/`payCost` take a `lifeSpend` that must be spent EXACTLY, not "at most" (a caster paying 4 for Dismember does it to keep two black up, and a search free to under-spend would overrule them); and the cast REFUSES an amount outside that list rather than clamping it. 🤖 **AI POLICY, pinned both ways:** one `planGoalPayment` helper funds every goal (heuristic and search price it identically), **mana before life** (options ascend, first fundable wins ⇒ life is spent only when the board cannot make the colour) and **never below `desperateLifeThreshold`** — the SAME line `answerPayLife` holds a shockland to, because "how low may I take myself by choice" gets one answer. 5 tests including the boundary in both directions; always-pay and never-pay are opposite strength bugs. ⚠️ **THE INERT-MECHANIC WIRE nearly missed:** the pilot's affordability prefilter compared `convertedManaCost` against available mana, so Dismember's 3 against one untapped land made it invisible **on exactly the boards its printed alternative exists for**. It now reads a new `minimumManaValue`, a deliberate LOWER bound (over-filtering hides a castable card; under-filtering costs one scoring pass). 🧪 **67 new tests across five files; 41 sabotage runs, 39 distinct breaks, 37 RED and 2 PROVABLE NO-OPS** — and the no-ops are the interesting part, because each one was code that could not change an answer and each was therefore DELETED: data-tools' `P → 0` branch cannot move a MAX that always has a colour beside it, and a state-based check after the life payment changes nothing because `applyCastSpell` already ends with one **and** the action boundary runs another (that would have been a third copy of CR 704.3). **Three genuine escapes were found and fixed during the pass**: a snow probe that let a bare `{S}` carry the refusal while the component table was wide open (each unreadable SHAPE is its own card now); a printed-card play test that never read the POOL after a cast, so an offer and a charge disagreeing about what `{2/R}` costs stayed green; and a Dismember play test that never proved the life reading SPARED the mana. 📏 **THROUGHPUT AT PARITY, measured not assumed:** seed-99 gauntlet **97/320 = 30.3%, rows 17·14·19·7·8·10·17·5 — byte-identical to the recorded baseline**; the allocation probe plays **26,588 actions on BOTH arms** (identical play, not merely similar) at 534/535 scavenges vs main's 532/533 (+2 = the documented floor). No wall clock quoted; on this box it is worthless. 🧹 **ONE LATENT DEFECT FIXED IN PASSING:** `colorsOfDefinition` walked WUBRG for fixed pips and PRINTED order for hybrid ones, so `{G/W}` answered `['G','W']` while `{W}{G}` answered `['W','G']` — two answers to one question, now one walk over the five pips. 📏 **MEASURED AND DELIBERATELY NOT BUILT:** `parseManaSymbols` (the clause-level parser behind ACTIVATION, kicker, equip and upkeep costs) still reads plain pips only, so a `{G/W}` or `{W/P}` in an activation cost reports exactly as before. A spike that taught it every hybrid family left the corpus at **725 — zero gained, zero lost**, so the blast radius buys nothing today. The refusal string was RENAMED: `'Phyrexian and monocolour hybrid mana costs'` promised two families the engine now delivers, so what remains is `UNPAYABLE_MANA_SYMBOL_GAP` (snow, and any symbol with a piece outside the closed component table) — the compiler matches the hybrid SHAPE with one regex and decides what each PIECE means with a closed table, so the next unreadable symbol reports by name. ⚠️ **POOL NOT REGENERATED:** the three newly-playable names are not in `expansion-candidates.json` and `expanded-pool.ts` is generated from a gitignored scratch index this worktree does not have — left for whoever next runs `chore(data): regenerate the pool`. Until then the three cards are importable by decklist but not in the shipped pool.
- 2026-09-10 worker (fix/soak-violations-sweep): ✅ **SHIPPED: three deep-tier soak violations, and they were one sentence three times — something answered a rules question without asking the rule (§3.142).** All four reproductions are deterministic through `replaySoakMixedGame` (~200 ms each) and were diagnosed by instrumenting the replay, never from the violation text. **1. SPLIT SECOND (seed 3736754678, turn 27).** B cast its own Siege Smash, then tapped two lands and cast Mouser Attack! into it. The two invariants firing together was the tell: the offered menu was `[passPriority, tapForMana, tapForMana]` — the offer pass and the apply path AGREED — and the pilot was the third opinion, because `scoredSpellGoals` CONSTRUCTS casts from a mirror of core's timing gate with no split-second clause. Fixed by asking `splitSecondOnStack` once, at the seam in `decide` every constructed play passes through — **and at its SECOND home, `policyCandidates`, which no soak run could ever have reached** (the run plays the DEFAULT pilot, which goes through `decide`; `policyCandidates` is the search pilots' seam). A class fixed in one of its two homes is not fixed, and "the sweep did not report it" is not evidence it was not there. **2. THE BLOCKING CAP (seed 3455580742).** The gang search put two blockers on a Bristling Boar ("can't be blocked by more than one creature"); core reads both bounds of CR 509.1b, the pilot's copy read only the minimum. ⚠️ **This is the FIFTH printing of one defect** — the pilot's block mirror has been core's rule minus a clause for protection (§3.102), landwalk (§3.110), the requirement SIZE (§3.121) and now the cap — so the fix is not another clause: the ~70-line `canBlockByEvasion` copy of `canBlock` is now a one-line delegation, the count rule is ONE core predicate (`blockerCountAllowed`, exported for exactly this question), and `chooseBlock` ends by handing its finished blocks to `illegalBlockDeclaration` — the engine's own judge — shedding optional attacker-groups until they stand. **That gate is measured load-bearing**: with the count seam reverted to the old defect and the gate left in, the pinned seed still replays clean; only with both broken does it fail. **3. `landDropCap` (seed 3679986871) WAS NOT A RULES BUG — the CHECK was wrong.** B's two lands on turn 16 were both legal under Icetill Explorer (which prints an additional land AND lands from the graveyard); it blocked and died on turn 17, and the invariant compared a turn-16 count against a turn-17 cap. `landsPlayedThisTurn` is cleared only for the seat whose turn is BEGINNING and `additionalLandPlays` comes from a permanent that can die, so **no single state holds both halves of that comparison**. `packages/sim/src/land-drop-cap.ts` is one running judgement — the count against the largest cap that seat has held since its own turn began — folded over every settled state by BOTH consumers, which each carried their own copy of the flat comparison. 🔎 **AND THE IDENTITY GUARD GOT A GUARD.** §3.140 moved a matchup's identity into `PINNED_IDENTITIES` and wrote the rule it must obey — *name cards from BOTH decks* — in the table's doc comment. This branch makes it EXECUTABLE: `soak.test.ts` walks the TABLE (not one file's rows, so `loop-runaway.test.ts` is covered too) against the pinned decklists and fails any entry naming nothing from one side, plus the reverse — a pinned matchup with no identity at all. ⚠️ A rule that lives only in a doc comment is a rule the next row gets added without reading, and this branch added three rows. 🧪 **Eight sabotages, all RED where a guard claims coverage — including one deliberately reported GREEN:** sabotaging the SHARED count rule leaves the blocking row passing, because the engine and the pilot then agree and nothing is rejected. That row guards the pilot's AGREEMENT with core; core's own rule is guarded in `combat-keyword-family.test.ts`, which does go red. 📊 **Gauntlet at seed 99 byte-identical: 97/320 = 30.3%, rows 17 · 14 · 19 · 7 · 8 · 10 · 17 · 5.** 📊 **DEEP TIER 12 → 8 → 0**, measured twice at 2,083 games: **8** before `fix/pilot-repeatable-noop` merged (all `gameCanEnd`, 8 distinct seeds, every violation decklist containing Bog Initiate — the sibling's defect, untouched here; all four of MINE already gone), then **0** with it merged in (287,766 ms CPU). ⚠️ The "before" only exists because a check started looking: the same run on this branch's starting point reported 0 violations and **8 "mandatory loop" DRAWS** — §3.140 turned those draws into the violations they always were. ✅ **`npm run verify` exit 0** — 399 test files, **21,780 passed / 0 failed**, and `npm run build` exit 0. (An earlier bare `npx vitest run` on the same tree, on a busier box, also failed the settled-leader pair in `determinism.test.ts` — flaky under concurrent agents by construction; 20/20 green in isolation and green in the verify run.) ⚠️ **Untouched on purpose:** the eight Bog Initiate violations are `fix/pilot-repeatable-noop`'s seam.
- 2026-09-10 worker(fix/pilot-repeatable-noop): ✅ **SHIPPED: the pilot's repeatable no-op — an ability that gives back exactly what it takes (§3.141).** §3.140's first sweep with `gameCanEnd` un-blinded found 12 violations over 2,000 deep-tier games and **eight were one card**: the pilot activating Bog Initiate (`{1}: Add {B}`) ~665 times in a single turn, paying the `{1}` with the `{B}` it had just made, until CR 104.4b drew the game. ✅ **THE DEFECT IS A PRICING CATEGORY ERROR, not a bad card:** every scorer prices an activation by its EFFECTS, which is right whenever cost and payoff are different currencies — a mana ability is the one shape where they are the same one, so `addMana` booked 4 per symbol against a `passScore` of 0 and the cost never entered the sum. ✅ **THE RULE, and it is an EQUALITY rather than an estimate: a pure mana exchange is worth nothing when the pool it would leave behind is the pool it started from.** NOT "never activate a mana ability twice" — the same `{1}: Add {B}` on a red pool is a genuine colour fix and is still taken. ⚠️ **THE PREDICTION RUNS CORE'S OWN `payCost` WITH THE SAME SPEND PURPOSE `applyActivateAbility` USES**, which is load-bearing: core spends generic in `C,W,U,B,R,G` order, so on a `{B}{R}` pool the `{1}` eats the **black it is about to remake** and the red is never touched — a pilot modelling the spend itself would have "fixed" a colour the engine was never going to fix. One pinned row was written the other way round first; the code was right. ⚠️ **ASKED OF THE POOL AS IT WILL BE AT ACTIVATION (current pool + the funding plan's production), not as it is** — see the escape below. **One predicate, both scorers** (`bestFundedActivation` and §3.55's `bestOfferedActivation`); sabotaging either alone reproduces the full runaway (662 / 667 activations), so both are pinned. 📊 **THE CLASS, MEASURED: 43 printed `addMana` activations in the pool, exactly TWO rider-free — Bog Initiate and Agent of Stromgald's `{R}: Add {B}`.** The second is why this is a shape and not a card name: it can never be a no-op (black mana cannot pay `{R}`), so it is never refused. A committed guard walks the SHIPPED pool and requires every pure exchange to be either unpayable from its own output or ruled a no-op on it — the card printed tomorrow with this shape fails in a millisecond rather than in a 2,000-game soak. 📊 **DEEP TIER, 2,000 games: `gameCanEnd` **8 → 0**, total violations **12 → 4** — and the four that remain are exactly the pre-existing, unrelated ones §3.140 reported and did not fix (split second ×2 on seed 3736754678, the Bristling Boar block restriction on 3455580742, `landDropCap` on 3679986871), so the deep tier is still red for those and nothing else; all eight seeds clean on BOTH seats** (replayed through `replaySoakMixedGame`, 16 rows, 0 violations). Seed 3791358276 is pinned in `soak.test.ts` with its decklists recorded and an identity naming cards from BOTH decks (`Bog Initiate` + `Nezumi Cutthroat` are B's, `Prodigal Pyromancer` + `Tar Pitcher` are A's) — swapping either deck was checked and turns the row RED on identity. 📊 **GAUNTLET `"Mono-Red Aggro" --games 40 --seed 99`: BYTE-IDENTICAL before and after, 97/320 = 30.3%, rows 17 · 14 · 19 · 7 · 8 · 10 · 17 · 5** — both halves re-measured on this branch, not quoted. **And the reason is measured too: none of the nine sample decks prints a rider-free `addMana` activation**, so the guard cannot fire in those 320 games. ℹ️ **HOT PATH: the cheap half runs first, and `manaExchangeIsNoOpOnceFunded` OWNS that ordering rather than leaving it to the call site** — `bestFundedActivation` is also the MCTS rollout policy (~20,000 calls per look-ahead decision), and predicting the post-tap pool costs a battlefield scan + a pool copy per planned tap. **Deliberately not benchmarked and here is why: `core/bench/scavenge-probe.ts` plays RANDOM actions, not the pilot, so it cannot see this path at all**, and wall clock on this box is worthless. The claim is "strictly less work", not a measured speed-up; the decisions are pinned identical either way. **Sabotages: 11 run, ONE escaped** — making `poolAfterPlan` ignore its funding plan left every row GREEN, because the funded path plans taps before it judges: the pre-tap pool cannot pay, the guard ruled "not a no-op", the pilot emitted the tap, and the offered path refused one decision later. No loop, but a land spent on nothing and the mana stranded at end of step. **"The loop stopped" and "the pilot plays well" are different claims**; the all-black row now asserts no tap either. ⚠️ **A TRAP FOR THE NEXT FIXTURE AUTHOR, reported not fixed: `packages/ai/src/test-support.ts`'s `createTestRegistry` registers only `dealDamage`**, so a fixture that resolves any other primitive gets a SILENT no-op — this branch's first draft drove the pilot correctly, watched the ability resolve and found no mana in the pool. The new tests use `buildRegistry()` (the real bodies) and say why at the call site; making the fixture registry honest for everyone is left undone because the ai package's stated rule is core-only and only its TESTS may reach for `@jonny-boi/cards`. ℹ️ **Branched off `origin/main` and merged `origin/fix/games-that-cannot-end-v2` immediately** — the un-blinded `gameCanEnd` and `PINNED_IDENTITIES` are what this fix is measured against; `origin/main` has since merged it too (`2556d55`), so the branch carries no extra content.
- 2026-09-10 worker(fix/games-that-cannot-end-v2): ✅ **SHIPPED: `gameCanEnd` could not see the class it exists for — §3.140.** A soaked game has TWO runaway bounds: the game-wide action cap (6,000) and a per-TURN bound (2,000) that CR 104.4b draws on. The invariant watched only the cap, so every runaway tripped the smaller bound first, was filed as a legal loop draw, and never reached the counter being read. ⚠️ **MEASURED: revert §3.33's copy-chain valuation and seed 1390617766 resolves 661 spell copies in one game, ends `loop` at 2,280 actions — and `soak.test.ts` passes 19/19, pinned rows included.** Both doors now push a violation and both tiers ask through one funnel (`runawayGames`); the three §3.33 rows became real guards the moment that landed. ✅ **The engine still cannot tell a MANDATORY loop from a pilot that will not stop, and does not try** — each row reports the game's heaviest traffic (minus the bookkeeping spine, which is top-three in every runaway and buried `spellCopied ×661` at rank six) plus the split that decides it: **664 answered / 0 auto-answered for the copy mirror, 398 / 1,980 for Dualcaster Mage + Rite of Replication**. `loop-runaway.test.ts` pins both verdicts and asserts they disagree. 📊 **DEEP-TIER SWEEP, 2,000 games: 12 violations, EIGHT of them newly visible `gameCanEnd` runaways — and all eight are ONE CARD.** ⚠️ **FOR THE PILOT'S OWNER (not mine, not touched): seeds 3791358276, 3505743309, 437769586, 506638966, 2340004011, 1830547618, 44358381, 876545993 — the pilot activates Bog Initiate ~665 times in one turn.** Its printed ability really is `{1}: Add {B}` (Invasion; the compiler is correct — measured, 0 of 563 printed coloured activation costs mis-compile), so it pays `{1}` with the `{B}` it just made, for ever, for no net change. Of the 13 generic-cost `addMana` abilities in the pool, twelve carry `tap`/`sacrificeSelf`; **Bog Initiate is the only rider-free one.** A repeatable ability with no net state change must not keep being chosen. ⚠️ **ALSO PRE-EXISTING AND UNRELATED, reported not fixed:** split second (`legalActionsOnly` + `noRejectedActions`, seed 3736754678 turn 27 upkeep — `castSpell#61 was never offered`), a blocking restriction (`noRejectedActions`, seed 3455580742 — "Bristling Boar can't be blocked by more than one creature"), and `landDropCap` (seed 3679986871 — "B played 2 lands this turn"). Reproduce any of them with `JB_SOAK_GAMES=2000 npx vitest run packages/sim/src/soak-deep.test.ts`. 📊 Gauntlet `"Mono-Red Aggro" --games 40 --seed 99` **byte-identical before and after** (97/320 = 30.3%, rows 17 - 14 - 19 - 7 - 8 - 10 - 17 - 5), re-measured on origin/main rather than trusting §3.33's weeks-old figure. Nine sabotages, **two escaped and both were real defects fixed here**: a pinned row whose identity cards all sat in one deck stayed green when the other was swapped (identities now live once in `soak-pinned-decks.ts` and name cards from BOTH decks), and the mandatory-loop row scanned a seed list until it agreed with itself.
- 2026-09-10 worker (feat/trigger-body-templates-v2): ✅ **SHIPPED: trigger/ETB BODIES — a stranded branch rescued, and an honest account of what of it was already done by others (§3.139).** The three-week-old `feat/trigger-body-templates` (tip `b1ea6c2`) could not merge — 362 commits landed past it — so it was ported by hand onto current main. ⚠️ **HALF OF IT HAD ALREADY SHIPPED UNDER OTHER NAMES, and was DROPPED rather than re-landed:** its karoo bounce body is main's `return-chosen-land-you-control` + `returnChosenToHand` (Azorius Chancery already compiled `'complete'`), and its permanent additional-land grant is main's `additional-land-plays` reading `CardDefinition.additionalLandPlays` (Exploration and Azusa already compiled). Re-landing either under a second name is the "one concept, two definitions" failure this repo has unwound before. ✅ **WHAT SURVIVED THE PORT:** the last three trigger scopes with no optional "you may" sibling (dies, cast-a-spell, draws-a-card); `OPTIONAL_YOU`, because every "you may" wrapper hands the effect table the text with "you may " REMOVED and a rule anchored on `^you ` then refused a card whose only unread word the wrapper itself had deleted; the each-player edict (a `who` VALUE on `sacrificeChosen`, both answers held before anything leaves the battlefield — CR 701.16 makes it one simultaneous event); and the "for each" count — but as a table of singular→PLURAL ROW, never a second copy of the counts, with a test that walks the alternation out of the SHIPPED pattern so the two halves cannot drift apart. ✅ **ADDED FROM THE CURRENT AUDIT, not the three-week-old ranking:** the triggering-player edict (Sheoldred, Whispering One) and the causative "have that player lose N life" (Suture Priest, Blood Seeker). Plus the class behind them: the printed edict noun list existed in FOUR copies and the noun→filter answer in three; one `SACRIFICE_NOUNS` + `sacrificeNounFilter` now serve all five sacrifice rules. 📊 **709 → 722 playable as a SET DIFF — thirteen names gained, ZERO lost.** New committed tool `packages/cards/scripts/playable-set.mjs`: two runs can agree on 709 and disagree about WHICH 709, and a count comparison cannot tell you. 19 tests; **15 sabotages run, 15 RED**. ⚠️ **ONE SABOTAGE FOUND A REAL HOLE IN MY OWN TEST:** "sacrifice as each seat answers, instead of holding both answers" SURVIVED the first draft — asserting that both seats were ASKED says nothing about whether the second answered on a board the first had already changed. The test now reads the battlefield at each ask. That is the second time this family's sabotage pass has caught its own untested refusal. 📏 **DELIBERATELY NOT BUILT, with the number that decided it:** the one-shot "additional land THIS TURN" (Explore, Urban Evolution) is **2 cards** and needs a new per-seat turn field in `PlayerState` plus its clone/serialize/reset answers and a new primitive; the symmetric "EACH player may play an additional land on each of THEIR turns" (Rites of Flourishing) is **1 card** and needs `additionalLandPlays` to grow a `who`, which is a shape change to GENERATED pool data. The audit's own top rows are worth 10–21 cards each. 🔎 **THE TAIL IS FLAT, and the next agent should know before picking template work:** 1,376 distinct gaps, 1,351 of them one-off templates, and the biggest single one-clause shape in the whole 2,100-card corpus unblocks **three** cards. Cards-per-edit in the body family is now 1–2, so the leverage has moved to the ENGINE-SYSTEM rows: copy-creating templates (21), block restrictions whose selector reads effective P/T (16), Phyrexian and monocolour hybrid mana (8). ⚠️ **POOL NOT REGENERATED:** the 13 names are recorded in `expansion-candidates.json`, but `expanded-pool.ts` is generated from a gitignored 79MB scratch index this fresh worktree does not have, and refreshing the card index afterwards is a network step. Left for whoever runs the next `chore(data): regenerate the pool`.
- 2026-09-01 integrator: ✅ **SHIPPED: `swap --until-decided` — a decisive swap now costs a QUARTER of the games (§3.92).** §3.87 measured this axis (upper bound 1.99x) and deliberately did NOT build it, because the naive version — peek after every game, stop at the first `p < 0.05` — is **the same error as §3.82's seed-shopping, in the time dimension**. This is the sound version. ✅ **THE MECHANISM: a PRE-REGISTERED Pocock boundary.** Fix the look count IN ADVANCE; every look clears the same tighter threshold. `sequential.ts` holds the constants as a **CLOSED TABLE** — an untabulated look count is **refused, never interpolated**, because an interpolated boundary is an unknown error rate wearing a number's clothes. At the default K=4 each look is judged at **0.0182**, so the run-wide false-positive rate is still the 0.05 the report quotes. ✅ **THE ENABLER: windows are PREFIXES.** `planPairedSlices` gained an optional `window`, and because every game seeds off its **absolute** (opponent × game) index, `[0,G)` then `[G,2G)` yields exactly the games `[0,2G)` would — stopping early plays FEWER games, never DIFFERENT ones. `sequential.test.ts` pins that against `evaluateSwap` with `JSON.stringify` equality. 📊 **MEASURED (200 games/matchup, 6 workers): decisive swap 3,200 games/10.77s → 800 games/5.75s, same verdict, "stopped after 1 of 4 looks, 75% of the budget unspent". Marginal swap: runs the FULL budget, same verdict, and the SAME wall clock (14.1s either way) — the feature is FREE when it cannot help.** ⚠️ **A BUG FOUND BY MEASURING RATHER THAN ASSUMING, worth knowing generally: `runJobsOnWorkers` is pool-run-CLOSE.** Calling it per window hired six fresh worker threads each time, and worker boot dominates a short run — so a **4x cut in GAMES came out as only a 1.95x cut in WALL CLOCK**. Hold ONE `createWorkerPool` across batches (as `suggest-workers.ts` already does) whenever you loop over job batches. ℹ️ Does not apply to `suggest`: its adaptive ladder already eliminates candidates between waves — the same saving one level up (§3.6). 📈 Against §3.91's price of the goal (1.48 × 3.60 × 1.99 ≈ 10.6x stacked at absolute bounds), this converts part of the third factor from a BOUND into a shipped feature.
- 2026-09-01 integrator: 🧮 **A CORE IS NOT WORTH A CORE — measure the machine's REAL parallel ceiling before optimising toward the core count (§3.91).** This reframes §3.77: **`suggest` at 2.56x on six workers is not 43% efficiency, it is 71% of everything this box can give.** ⚠️ **THE DECISIVE TEST USES NONE OF OUR PARALLEL CODE** — run single-threaded `pilot-bench` alone, then six copies as SEPARATE PROCESSES with no shared state, no barriers, no coordination at all: **one alone 182 games/sec; six at once 110/109/110/108/109/110 → 656 aggregate = 60% per-process efficiency = a CEILING of 3.60x from 6 cores.** The workload is memory-heavy and all-core clocks sit below single-core boost, so **embarrassingly parallel work does not scale linearly here**. Committed as `bench/parallel-ceiling.mjs` — re-measure it on your machine, do not assume it. 📍 **HOW I GOT THERE, so the diagnosis is repeatable:** the scaling curve plateaus at the physical core count and DEGRADES past it (1w 26.9s · 2w 15.6s · 4w 11.0s · **6w 10.5s** · 8w 11.9s · 12w 13.3s). New `JB_SUGGEST_TRACE=1` (kept) prints per-phase wall clock: **11,073ms traced against an 11.19s run — every millisecond is inside a batch, the host contributes nothing**, and a CPU profile of the host confirms it at **98.6% idle**. The obvious suspects are absent: `loadCardPool` 13ms, `buildRegistry` 1ms, **`openArm` 0.2ms** (it builds AND legality-checks a variant deck from a 5,065-card pool — do not bother optimising it). The slow first base batch is six worker threads booting, ~1.5s, which amortises on longer runs. ✅ **RE-JUDGED: 2.56 / 3.60 = 71% of achievable**; the missing 29% is worker boot plus the round barriers the ladder requires. §3.77's headline 2.89x was closer to optimal than I reported it. 📊 **AND THIS FINALLY PRICES "10x FASTER" WITH NUMBERS INSTEAD OF OPINION — the ceilings multiply:** single-thread engine **1.48x achieved** (profile flat, no hotspot, §3.78–§3.81) × parallel hardware **3.60x CEILING** (2.56x achieved) × fewer games needed **1.99x UPPER BOUND** (mostly already taken, §3.87) **≈ 10.6x — and every factor there is an optimistic bound no real implementation reaches.** Achieved today: **1.48 × 2.89 ≈ 4.3x** on `suggest` versus where this work started. **10x is not merely hard on this machine; it sits at the exact edge of what the hardware, the profile and the statistics permit combined, and only if every ceiling were hit precisely.**
- 2026-09-01 integrator: 🔎 **THE BLOCKING BAND, EXAMINED — plus a diagnostic that was LYING (§3.89).** ⚠️ **FIX FIRST: `disagreement.mjs` printed every position with the labels `heuristic:` and `lookahead:` HARDCODED**, so under the `--base` flag §3.88 added it attributed the base pilot's move to "heuristic" and the rival's to "lookahead" **regardless of what was actually run**. A mislabelled diagnostic is worse than none — every conclusion drawn from it is backwards for half the runs. Now prints the pilot ids it was given. ✅ **NEW CAPABILITY: `forecast-ab.mjs --heuristic <field>`** varies a **HeuristicWeights** field on the **lookahead** pilot. This matters: lookahead DELEGATES blocking, land sequencing and spell choice to the heuristic, so those are now testable on the **shipped** pilot — which `weight-ab.mjs` (heuristic-only) cannot do. 📍 **THE BLOCKING DISAGREEMENTS ALL HAVE ONE SHAPE:** `hybrid` BLOCKS where the shipped pilot passes, spending a small creature to stop a large hit at healthy life (16, 12, 14). The mechanism is already in the pilot and it is ONE NUMBER: `chooseBlock` chump-blocks only when `desperate = facingLethal || myLife <= weights.desperateLifeThreshold`, and that ships at **10** — so a defender at 16 taking 6 is not desperate and declines. **MEASURED, BOTH DIRECTIONS:** `10 → 16` (block far more readily) **held-out 32/92, chi2 28.07 — CONFIRMED WEAKER**; `10 → 5` (block less) held-out **45/29 chi2 3.04** then, on a **FRESH battery at 3x games**, **113/89 chi2 2.62** — not replicated either time. The 16 result is decisive and useful: **blocking MORE is clearly wrong — the defensive twin of §3.86's five aggression findings.** The 5 result leans positive in 3 of 4 seeds across two independent batteries and never crosses: too small to matter, or nothing. Not shipped. ⚠️ **THE DISCIPLINE THAT COST THE SECOND RUN:** having tested 16 and then 5, choosing 5 and confirming on the SAME held-out seeds would have repeated §3.85's error exactly — **the seeds that SELECT a variant cannot also VALIDATE it**. `--seed S` shifts the whole battery; the fresh four agreed with the first four, which is the only reason this verdict can be trusted. 📍 **WHAT THIS LEAVES:** the blocking gap is **NOT a threshold problem** — the one dial governing it is at or near its optimum in both directions. Whatever `hybrid` sees is in the VALUE judgement of a specific block, not in when the pilot is willing to chump. **Land choice (9.7%) and spell choice (7.5%) remain unexamined** and are now reachable with `forecast-ab.mjs --heuristic`. 📊 **Tally: two confirmed strength gains shipped, SEVENTEEN hypotheses killed.**
- 2026-09-01 integrator: 🚨 **CORRECTION TO MY OWN §3.82–§3.86 — THE PILOT WE SHIP IS `lookahead`, NOT `heuristic` (§3.88).** `DEFAULT_PILOT_ID` is `LOOKAHEAD_PILOT_ID`, in the CLI and in the web Lab (its pilot list literally reads "Lookahead (default)"). `lookahead` (§3.47) delegates every decision to an unmodified heuristic **EXCEPT the attack declaration**, which it decides with `combat-forecast.ts`. Two consequences, both mine to own: ⚠️ **(1) `setAttack` (§3.83) DOES NOT CHANGE THE DEFAULT PILOT.** It improves `heuristic.chooseAttack`, which lookahead replaces. The gain is real and confirmed (held-out 94/52) and it does reach `--pilot heuristic` runs and the ROLLOUT POLICY inside `hybrid`/`mcts` — but §3.83 said "the pilot" without saying which, and a reader would reasonably assume the default. ⚠️ **(2) "100% of the disagreements are in `declareAttackers`" (§3.82) WAS A TAUTOLOGY.** Comparing heuristic to lookahead can only surface attack disagreements — the two share every other decision by construction. That described the shape of the COMPOSITION, not a property of the pilot, and it steered four sections of work into one step. ✅ **THE MEASUREMENT THAT SHOULD HAVE BEEN RUN** (`disagreement.mjs --base lookahead --pilot hybrid`, new `--base` flag, 9,366 real-choice decisions): **175 disagreements (1.87%), spread across the whole game — attacks 60%, BLOCKING 14.3%, LAND CHOICE 9.7%, SPELL CHOICE 7.5%, MANA SEQUENCING 5.7%.** ⚠️ **AND THE DIRECTION REVERSES:** against the heuristic, lookahead is the cautious one; against `hybrid`, **lookahead is too PASSIVE — hybrid attacks where it passes 60 times to 6.** Same conclusion as §3.86 from the other side, now for the pilot that actually ships. ✅ **NEW TOOL `bench/forecast-ab.mjs`** — A/Bs the shipped pilot's own `ForecastWeights` on the four-seed held-out battery (`weight-ab.mjs` tunes the heuristic, which is not the default). ❌ Its first hypothesis failed: `crackBackPerPoint` 0.5→0.25 (the aggression dial) measured **held-out 53/36, chi2 2.88 — NOT REPLICATED**; pooled over all four seeds it reaches chi2 3.94, exactly the marginal seed-dependent shape §3.85 exists to reject. 📍 **THE STANDING DIRECTION, CORRECTED: the default pilot's headroom is NOT concentrated in attacks.** Blocking, land choice and spell choice are a THIRD of it and **none has ever been examined** — every strength section before this one looked only at attacks, because the comparison chosen could not show anything else. Use `disagreement.mjs --base lookahead --pilot hybrid --show N`.
- 2026-09-01 integrator: 📏 **THE FOURTH AND LAST SPEED AXIS, MEASURED — "how many games did the verdict actually NEED?" (§3.87).** The other three axes are all about making the work cheaper; this one asks how much of it was needed at all. New tool `bench/early-stop.mjs` replays a real paired A/B **slot by slot** and finds the earliest point at which the verdict was already the final one AND already significant. An arm that never reaches significance is charged the FULL budget — the honest accounting, since an inconclusive answer needs every game by definition. **RESULT (15 legal swaps, 8 opponents, 160 paired slots each): slots played 2,400; a perfectly-calibrated test would need 1,204 — UPPER BOUND 1.99x.** Decisive swaps settle at 27-137 slots; the two inconclusive ones never settle. ⚠️ **"UPPER BOUND" IS DOING REAL WORK THERE:** stopping at the first `p < 0.05` while peeking after every game inflates false positives badly — **the same error as §3.82's seed-shopping, in the time dimension**. A sound group-sequential design spends games buying that error back, so it delivers materially less; honest first-pass expectation ~1.4x. ✅ **MEASURED AND DELIBERATELY NOT BUILT.** `suggest` — where this would matter most — **already realises most of it**: its adaptive ladder eliminates candidates between waves, the same saving at the candidate level rather than the slot level (§3.6). The remaining value is for `swap` and `pilot-ab`, and ~1.4x on two commands is not worth adding sequential-testing machinery to a codebase that has just paid twice for lessons about exactly this kind of statistics. Measure first, follow the measurement. 📊 **THE SPEED QUESTION IS NOW CLOSED ON ALL FOUR AXES, with a number for each:** per-action cost **flat** (heaviest 6.1%, §3.78) · action count **no removable share** (ceiling under 1.35x, §3.79) · decision cost **flat** (heaviest 8.4%, already tuned, §3.81) · games needed **upper bound 1.99x, mostly already realised** (§3.87). None contains a 10x, and together they account for essentially all the work the sim does. **The throughput that WAS won — +48% single-thread (§3.62) and 2.89x on `suggest` (§3.77) — came from the two things this table does not measure: doing FEWER decisions, and doing them on MORE CORES.**
- 2026-09-01 integrator: 🛑 **THE AGGRESSION QUESTION IS CLOSED — five ways to make the pilot more cautious, ALL measured worse or nothing (§3.86). Do not attempt a sixth.** `lookahead` declines attacks this pilot makes, which looks like a defect. It is not. **THE TABLE, so nobody re-runs any of it:** `trimForDefence` (§3.75) weaker 18/39 · `attackValueThreshold` 1→3 (§3.82) weaker 22/65 · `attackValueThreshold` 1→2 (§3.84) **CONFIRMED WEAKER** 15/95 and 6/93 · `defensiveReserve` (§3.85) not replicated, held-out 145/146 · `manaCreatureCost` (§3.86) **CONFIRMED WEAKER** 7/18. ✅ And the ONE rule that confirmed — `setAttack` (§3.83) — makes the pilot attack **MORE precisely, usually with MORE bodies**, by noticing the defence cannot block them all. 📍 **THE LAST ATTEMPT WAS THE BEST-MOTIVATED ONE AND IT STILL FAILED:** `disagreement.mjs --band set` (new flag) prints only the band where BOTH pilots attack with a different roster — the largest remaining band at 48.7%. In **four of seven** such positions the extra body we send is a **MANA CREATURE** (Llanowar Elves, Birds of Paradise, Eternal Witness) going in for 1-2 damage; attacking taps it, so the mana it would have made in the second main is gone — a cost the combat maths never saw. Charged at 1 it barely fired (at parity the score is unchanged and ties keep the incumbent: **watch for that whenever a new cost equals an existing benefit**); charged at 2 it was CONFIRMED WEAKER. ⚠️ **THE STANDING CONCLUSION:** §3.75 guessed from one experiment that copying a searching pilot's CONCLUSION is not the same as having its REASONS. Five experiments now say it. `lookahead` is more cautious than is correct in this engine, and a rule shaped like its caution throws away races we are winning. **The attack step is at a local optimum for this architecture.** What is left is not a missing rule but a different CLASS of pilot — one that evaluates positions rather than scoring them, which `lookahead`/`mcts` already are and which measures only modestly stronger (42 slots to 10, 88% level, 99% decision agreement). 📊 **Tally: two confirmed strength gains shipped (§3.74, §3.83), FOURTEEN hypotheses killed. Both survivors make the pilot act MORE, not less.**
- 2026-09-01 integrator: 🚨 **TWO SEEDS ARE NOT ENOUGH IF YOU TUNED ON THEM — the A/B bar is raised again (§3.85).** §3.82 made every A/B run twice on independent seeds. This round found the hole in that rule by falling through it. ⚠️ **WHAT HAPPENED, IN ORDER, BECAUSE THE ORDER IS THE LESSON:** a `defensiveReserve` rule measured **20/17 and 22/17** (inconclusive, positive both) at 2,880 games; a WIDENED two-swing variant measured **22/41 and 24/30** (worse); back on the one-swing variant at 11,520 games it measured **94/67 (p=0.041) and 95/64 (p=0.017) — "CONFIRMED STRONGER" under the §3.82 rule**. Then two seeds it had NEVER SEEN: **77/78 and 68/68 — dead level.** ❌ **The one-swing variant had been CHOSEN over the two-swing variant BY THOSE SAME TWO SEEDS**, which then validated the thing they had selected — overfitting with extra steps. Held-out effect: 145/146, nothing. **Not shipped.** ✅ **THE FIX:** `bench/ab-protocol.mjs` now runs a **FOUR-SEED BATTERY — two to develop against, two that DECIDE** — pooling the held-out slots into one McNemar. `--seed S` shifts the whole battery, so a genuinely fresh set of four is one flag away (do this after tuning against the defaults). The dev seeds are printed but **carry no weight in the verdict**: their agreement is not evidence, it is the thing being tested. ✅ **THE SHIPPED FEATURES WERE RE-VALIDATED against the stricter bar** — a rule that rejected them would matter far more than one that rejects a candidate. `setAttack`: dev 58/21 and 60/23, **HELD-OUT 51/23 and 43/29 → CONFIRMED STRONGER, held-out 94/52 (chi2 11.51), pooled 212/96**. All four seeds lean the same way; §3.83 is real. (§3.74's alpha strike is 158/0 on a fresh seed — never in doubt.) ⚠️ **SECOND TRAP, SAME ROUND — THE BENCHES IMPORT FROM `dist`.** Reverting a source file and re-running an A/B **without rebuilding** measures the OLD code and says nothing about the tree. It produced a plausible-looking **46/21** for a feature whose real number is **58/21** — plausible enough that I nearly wrote it down. **Rebuild between a revert and a measurement, every time.** 📍 Also new: `disagreement.mjs --show N` prints disagreements as readable BOARDS rather than counts — every hypothesis in this round came from reading eight of them, after eight guessed from histograms had failed. 📊 **Tally: two confirmed strength gains shipped, TWELVE hypotheses killed. Two of the twelve had cleared the bar in force at the time** — which is the whole argument for raising it.
- 2026-09-01 integrator: 📍 **THE SEARCH IS NOT THE BOTTLENECK — THE SCORING IS (§3.84).** Four measurements, no code shipped, one result that should redirect every future attempt at the attack decision. ✅ **§3.83 WORKS OUTSIDE ITS OWN A/B:** re-running `bench/disagreement.mjs` after the set-attack rule shipped, total disagreements with `lookahead` fell **271 (0.80%) → 191 (0.54%)**, a 29% drop, and the band §3.83 targeted is the one that shrank (heuristic-attacks/lookahead-passes 162 → 78). ❌ **ATTACKING LESS IS DEFINITIVELY WRONG, NOW REPLICATED:** `attackValueThreshold` 1→2 measured **15 / 95 (p=5.0e-14)** and **6 / 93 (p≈0)** — `CONFIRMED WEAKER`, about as one-sided as anything measured in this repo. The 40.8% of disagreements where lookahead declines an attack we make are **NOT** misplays by us. That direction is closed; do not re-open it. ⚠️ **THE RESULT THAT MATTERS — `bestAttackSet`'s local move set is ALREADY EFFECTIVELY EXACT.** The obvious objection to "greedy roster + all-in + single toggles" is that the best attack might be two moves away, so I made it exhaustive for boards ≤6 attackers (all 64 subsets scored). Result: **out of 1,440 matched slots, THREE and SEVEN differed**, for +3.5% decision cost — `INCONCLUSIVE`. Enumerating every subset almost never finds a better attack than the local moves. **A smarter SEARCH is wasted effort.** ✅ **THE STANDING DIRECTION:** the gap is in the **SCORING FUNCTION**. `scoreAttackSet` models the defence as a greedy single-blocker assignment — **no gang blocks, no chump blocks, and no notion that attacking taps a creature out of next turn's defence**. If the attack decision improves further, that valuation is where it happens, and it must clear the two-seed bar (§3.82). ❌ Also killed: `faceDamageValue` 1→2 (24/39 then 25/20, INCONCLUSIVE) — named so it is not re-run. 📊 **Tally: two confirmed strength gains shipped (§3.74, §3.83), TEN hypotheses killed by measurement.** That hit rate argues FOR the harness, not against it: each cost minutes to test and would have cost days to argue about, and two of them would have shipped on a single-seed p-value.
- 2026-09-01 integrator: ✅ **STRENGTH GAIN SHIPPED — blockers are a shared resource, and the attack is now judged as a SET (§3.83).** The first confirmed strength gain since the alpha strike, and exactly what §3.82's map pointed at. **THE DEFECT:** `attackIsProfitable` judges every attacker INDEPENDENTLY against the FULL set of enemy blockers — as if each could be met by all of them. True of the first attacker, false of every one after: a defender with one body cannot answer four attackers however badly each fares alone. The pilot was declining attacks the defence had no way to punish. **THE FIX:** score whole candidate attacks against the defence's best answer — the greedy roster, the all-in roster, and each single add/remove from greedy (O(n) sets, not 2^n). The defender model is greedy and **deliberately the same model the per-attacker code already uses**: a sharper defender here would leave the two halves of the pilot disagreeing about the same board. ✅ **MEASURED ON TWO INDEPENDENT SEEDS (the §3.82 bar): run 1 `58 / 21`, p=5.12e-5; run 2 `60 / 23`, p=7.77e-5 — CONFIRMED STRONGER.** Same direction, near-identical magnitude — this is what a real improvement looks like next to the fluke §3.82 caught. ⚠️ **RULE 7 WAS PAID BEFORE MOVING ON, and the fix was NOT in the new code.** First version cost **11% of sim throughput**. Measured on a fixed corpus (`pilot-decide-bench --feature setAttack`): naive **+6.9%** → flat arrays + bitmask candidates **+3-4%** → **+2.7%** after hoisting the attachment sweep. That last one: **`saboteurTriggerCount` walks the WHOLE BATTLEFIELD looking for things attached to its argument, so calling it per eligible attacker is O(attackers × battlefield)** — one sweep now collects hosts up front. Byte-identical behaviour across the optimisation (A won 851/2000 before and after; A/B unchanged to the slot). **+2.7% of decision time is a COST, not parity, and it is stated rather than rounded away** — under 1% of throughput, bought with a double-confirmed strength gain. ⚠️ **TWO MEASUREMENT TRAPS, BOTH NOW DOCUMENTED IN THE BENCH — I hit both:** (1) **`games/sec` CANNOT compare two pilots of different strength** — a stronger pilot plays DIFFERENT games (851 wins vs 806 on the same seeds), so throughput moves for reasons that are not cost; only a fixed recorded corpus answers "what does this cost?". (2) **Timing two arms back-to-back is order-biased and largely so** — timed sequentially, the arm doing strictly MORE work measured **9.9% FASTER**, because the second arm inherits a JIT-warmed process. The bench now interleaves reps and alternates which arm leads. ✅ Guard: `packages/ai/src/set-attack.test.ts`, 5 tests, with a control asserting the OLD rule refused exactly the attack the new one makes. Gate: **19,379 passed, 5 skipped, 0 failed (343 files)**.
- 2026-09-01 integrator: 🚨 **STOP USING SINGLE-SEED A/Bs. The method was wrong and it nearly shipped a fake improvement (§3.82).** ⚠️ **THE TRAP, IN FULL, BECAUSE ANY OF US WOULD HAVE FALLEN IN IT:** tuning `ownCreatureLossPerStat` from 1 to 1.5 measured **285 ahead / 215 behind, p = 2.03e-3 — "stronger"** over **11,520 games with 500 decided slots**. By the bar this repo had been using, that is a finding, and it was one edit from shipping with "measured stronger" in its commit message. Two NEARBY values agreed (1.25 p=0.029, 2.0 p=0.017), which felt like corroboration — **it was not, they were the same games**. Re-run on an INDEPENDENT SEED SET, the identical change measured **250 / 247, p = 0.93**. Nothing about it was real. ✅ **THE CONTRAST THAT MAKES THE RULE OBVIOUS:** the alpha strike (§3.74, shipped) on that same independent seed is **158 ahead / 0 behind**. A real improvement is **ONE-SIDED**. A 285/215 split with a good p-value is what a coin looks like when you test it enough ways. ✅ **THE FIX IS A GUARD, NOT A NOTE:** new `bench/ab-protocol.mjs` runs every A/B **twice on independent seeds** and judges replication; **`feature-ab.mjs` and `weight-ab.mjs` both go through it**, so there is one answer to "is this better?" and the two tools cannot drift. Verdicts are a closed set — `CONFIRMED STRONGER` / `CONFIRMED WEAKER` / `CONTRADICTORY` / `NOT REPLICATED` / `INCONCLUSIVE` / `NO EFFECT` — because my first draft printed "only the second seed set showed an effect" for a pair where NEITHER had. **Only `CONFIRMED STRONGER` is grounds to ship.** Verified both directions: alphaStrike → CONFIRMED STRONGER (37/0 then 36/0); the weight tweak → INCONCLUSIVE. ✅ **I RE-RAN THE SHIPPED FEATURES on the independent seed — nothing in the tree rests on a fluke, nothing needed reverting.** 📍 **THE MAP FOR WHOEVER CONTINUES STRENGTH WORK** (new `bench/disagreement.mjs`): **100% of the heuristic-vs-lookahead disagreements are in `declareAttackers`** — not one in casting, blocking, activating or land drops. 59.8% heuristic attacks / lookahead passes, **36.2% both attack with a DIFFERENT SET**, 4.1% the reverse. Aggression itself is at a local optimum (attacking less measured clearly WORSE at p=6.7e-6; attacking more is neutral or already done, §3.80), so the remaining gap is **which bodies go** — a set-level blocking-assignment problem, not another independent per-attacker rule. And it must clear the two-seed bar.
- 2026-09-01 integrator: **The PILOT measured on its own — 177,459 decisions/sec, and that profile is flat too (§3.81).** The goal says "make THE HEURISTICS 10x faster", and every measurement until now was games/sec — the engine PLUS the pilot — where a decision function twice as fast moves the number a few percent and reads as noise. New tool `bench/pilot-decide-bench.mjs` records every `(state, legalActions)` the pilot was asked about in real games, then replays ONLY `chooseAction` over that corpus, timed. **Baseline: 177,459 decisions/sec = 5.64 microseconds per decision.** ⚠️ **TWO TRAPS IT NOW DOCUMENTS, BOTH OF WHICH COST ME TIME.** (1) WARM UP: measured cold, seven IDENTICAL reps spread **56%** — wide enough to hide any real change; two discarded passes bring it to ~17%, and the reported figure is the median. (2) PROFILE WITH A SMALL CORPUS AND MANY REPS (`--games 8 --reps 40`): `--cpu-prof` covers the whole process and the recording phase calls `applyAction` once per decision, so the other way round the table says "the pilot spends 14% of its time cloning state" — **it does not**; the heuristic pilot never clones, only `hybrid` and `mcts` do. I was one edit from acting on that. **THE PILOT PROFILE:** `indexContinuous` 8.41%, `scoredSpellGoals` 6.36%, `choosePriorityAction` 5.31%, `planManaPayment` 5.10%, `bestSpellGoal` 3.93%. Heaviest 8.4%, top ten 48.4% — FLAT, like the engine's. And the heaviest item is already optimised: `indexContinuous` is a single battlefield pass with lazy allocation and a shared `EMPTY_INDEX` for a board that modifies nothing — the guard I went looking for was already there, in the one funnel, serving every caller. ⚠️ **SPEED IS NOW MEASURED THREE INDEPENDENT WAYS AND ALL THREE AGREE:** engine per-action cost flat (§3.78), action count has no large removable share (§3.79), pilot decision cost flat with its top function already tuned (§3.81). There is no 10x in any of them. ✅ **THE INSTRUMENT OUTLIVES THE QUESTION** — rule 7 says no hot-path regressions, and a new STRENGTH feature costs DECISION time. Quote this number for one; games/sec hides it behind the engine.
- 2026-09-01 integrator: **The strength band is mined, and the pilot leaves nothing obvious on the table (§3.80).** §3.79 pointed at the promising lead — 58% of everything the engine does is the pilot DECLINING an option it had, 3x the band where it acts. I mined it. **`missed-plays.mjs` over 7,435 turns: land drops left unused 0 (0.0%), main-phase passes holding a castable spell 0, attack windows declined 1,103/8,130 (13.6%).** The two omissions that would be flatly wrong are ZERO. New tool `bench/declined-attacks.mjs` splits the attack declines: FREE (no untapped defender) 17, UNBLOCKED (an attacker survives every block) 154, CONTESTED 927. ⚠️ **BOTH "DEFECT" BANDS ARE OVER-COUNTS AND THE TOOL NOW SAYS SO IN ITS OWN HEADER** — FREE is almost entirely 0-power mana creatures the pilot correctly keeps untapped ("5 attackers for 2 power"); UNBLOCKED reads printed power/toughness and ignores evasion and continuous effects, so it is not the question `attackIsProfitable` asks. ❌ **HYPOTHESIS KILLED — `safeAttacker`:** "a creature the defender cannot kill should attack whatever its power, because `attackValueThreshold` guards against a loss that cannot happen." Implemented behind a flag, A/B'd on matched slots: **9 decks, 2,880 games — ahead A 0, ahead B 0, level 1440. Not one game differed.** The pilot ALREADY does it: `attackValueThreshold` is 1, `faceDamageValue` is 1, and a 0-power attacker is rejected earlier, so anything with no profitable block against it clears the bar by construction. Dead code; reverted. ⚠️ **WHAT THIS SETTLES:** the 58% band is large but is not full of mistakes. The three omissions a rules-based pilot is normally guilty of — missed land drops, unspent mana, declined free damage — are zero, zero, and already-handled. With `lookahead` (real engine rollouts, the strongest play this engine offers) beating this pilot only 42 slots to 10 with 88% level and agreeing on 99.0% of all decisions, the headroom to near-optimal play is single-digit percent. **10x smarter is not available, because there is not 10x of anything left to take.** 📊 **Running tally: three speed hypotheses and three strength hypotheses killed by measurement (`trimForDefence` §3.75, the combat fast-pass §3.79, `safeAttacker` §3.80); two survived and shipped (alpha strike §3.74, the fast-pass gate §3.62).** That ratio is the point — ideas are cheap to test here and most are wrong, which is why they get tested rather than argued about.
- 2026-09-01 integrator: **The step census — only 18% of what the engine does is a PLAY (§3.79).** §3.78 proved there is no hotspot to attack, which leaves the other axis: not "make each action cheaper" but "perform fewer actions". New tool `packages/sim/bench/step-census.mjs` measures it over real games. **200 games, 109,159 actions (546/game): dead passes 23.8% (menu offered only the pass), live passes 58.0% (the pilot COULD have acted and declined), real plays 18.2%.** ⚠️ **THE TWO BANDS ARE DIFFERENT PROBLEMS AND MUST NEVER BE ONE "passes" NUMBER.** DEAD passes are a SPEED question — the gate (§3.62) already skips menu-building for most, but it returns `false` for `declareAttackers`/`declareBlockers` by construction, so **4,414 dead combat windows pay `generateLegalActions` in full = 4.0% of all actions**. That is the largest single piece of dead work left; a cheap combat pre-check ("no untapped creature I control") takes most of it, worth ~2-3% wall clock. Unclaimed — take it if you want it. ✅ **LIVE passes are a STRENGTH question and this is the more useful finding: 58% of everything the engine does is the pilot DECLINING an option it had.** Every misplay of omission lives there, and it is 3x the size of the band where the pilot acts. Strength work that samples "what did the pilot do?" is looking at 18% of the decisions; the interesting ones are the 58% it did NOT. `missed-plays.mjs` already mines that band — this is the measurement saying why it is the right one. ⚠️ **BOTH SPEED AXES ARE NOW MEASURED:** per-action cost has no hotspot (§3.78), action count has no large removable share (§3.79 — the unreachable CEILING of removing every dead pass is under 1.35x). 10x single-thread is not reachable in this architecture, and both statements are committed tooling you can re-run in a minute rather than claims to re-derive over a week.
- 2026-09-01 integrator: **The engine profile is FLAT, and that is the answer to "10x faster" — measured, with the tool committed (§3.78).** New: `packages/sim/bench/prof-report.mjs` turns a `.cpuprofile` into a **self-time** table (self, not total: a total-time table always blames the outermost frame, which is how an afternoon goes into a loop that is only expensive because of what it calls). It prints a FLAT/PEAKED verdict so the next reader gets the decision, not just numbers. Run it against `pilot-bench.mjs`, still the only harness worth profiling — the CLI plays in a worker, so `--cpu-prof` on it profiles a 99%-idle parent. **THE NUMBERS** (1,500 games, 5,421 samples): `generateLegalActions` 6.12%, `runMatch` 6.07%, `rememberSources` 4.89%, `planManaPayment` 4.10%, `scoredSpellGoals` 3.65%, `heuristicWillPass` 3.50%. **Heaviest single function 6.1%; top ten together 38.4%.** ⚠️ **WHAT THIS SETTLES:** deleting the most expensive function in the engine OUTRIGHT — not optimising it, deleting it — buys 6%. 10x needs 90% of all work gone, and this profile says the work is spread across the whole engine with nowhere for a fix to reach. Single-thread 10x is not available by optimisation; it needs a different state representation (flat typed arrays, no per-action event objects), which discards the byte-identical replays and the 19,000-test net. ⚠️ **DO NOT "FIX" `rememberSources`:** the 4.89% pre-action battlefield walk looks like pure waste on the 82% of windows that are passes, but it is what makes LAST-KNOWN-INFORMATION work — a permanent that dies mid-action is already out of `state.battlefield` when `zoneChanged` is scanned, so the pre-walk is the only reason its dies-trigger fires (CR 603.10). Deferring it to first use trades a rules bug for 5%. I had the idea, checked, and did not ship it; recorded so the next person does not. ✅ **WHERE THE THROUGHPUT ACTUALLY CAME FROM** — the two places this profile does not govern: fewer decisions (the fast-pass gate, §3.62 — 82% of windows never build a menu) and more cores (§3.53, §3.77). +48% single-thread and 2.89x on `suggest`.
- 2026-09-01 integrator: **`suggest` is fanned out — the full unification my own note below said was "the only shape that pays". It pays (§3.77).** ✅ **2.89x on search time, 2.51x wall clock, byte-identical report.** 200 games/candidate × 8 candidates: **54.19s → 18.73s**, 123 → 357 games/sec. Compare the shortcut I measured and rejected in §3.76: **1.06x**. ✅ **THE SHAPE.** One generator, `driveSuggestionArms`, holds everything that decides an ANSWER (opening arms, recording the ones that fail to build, progress, and building each verdict from the arm's own tally); it yields a whole round's requests and is resumed with the played arms. Two transports supply only the games: `suggestSwaps` plays them inline on a `PairedArmRunner`, `suggestSwapsWith` plays them wherever an `ArmTransport` says. The ladder, the elimination rules, the multiplicity correction, the ranking and the report are shared code — a pooled run is a TRANSPORT choice, not a second search with its own answers. ✅ **THE BASE PHASE IS THE PART THAT MAKES IT WORTH DOING.** Each round plays whatever base slots the ladder newly reached, then hands those records to every variant slice through the existing `baseRecords` seam. Without it, each of C candidates replays the shared base games itself and a pooled run does ~1.8x the total WORK to go 3x faster. The accounting proves it did not: the same run reports **6,691 games (1,600 base + 5,091 variant)** both sequentially and pooled. ⚠️ **THE TRAP THIS COST ME, WRITE IT DOWN:** `runSeed` equals the caller's `baseSeed` only on a deck's FIRST run — a run continuing a history plays on `gameSeedFor(baseSeed, runsCompleted)`. A transport that derived the seed itself would agree with the host exactly ONCE and then silently play a DIFFERENT set of games on every run after, reporting it as if nothing were wrong. Hence `ArmTransport.begin`: the search TELLS the transport its seed. The regression test runs a continued search and was confirmed to fail — alone, with the other four still passing — when `begin` is fed `baseSeed`. Second guard: an arm slice reporting `baseGamesPlayed !== 0` throws, because that is zero exactly when the base phase supplied every record the slice needed. ✅ **PROOF:** `suggest-parallel.test.ts` compares pooled vs sequential at shard widths 1/2/5 with slices executed in REVERSED order, `toEqual` AND `JSON.stringify` equality, only the two wall-clock fields normalised. Gate: **19,374 passed, 5 skipped, 0 failed**; lint 0 errors. ℹ️ `--no-adaptive` stays sequential on purpose (it is the control, not a speed path). The web Lab keeps its own fan-out — it carries replay capture, cancellation and progress concerns the CLI does not — but both go through the same `driveAdaptiveSearch` and the same `summarizePairedSwap`, so they cannot disagree about a verdict however they schedule the games.
- 2026-09-01 integrator: **⚠️ CORRECTION TO MY OWN NOTE BELOW — the "smaller step that is safe on its own" is NOT worth taking, and here are the numbers (§3.76).** I proposed pre-playing the shared BASE arm on workers and feeding it to the sequential search through the existing `baseRecords` seam, estimated at ~1.35x. I built it. It worked — CLI output **byte-identical** to the sequential run, with the accounting corrected so games played on workers were counted rather than reported as "saved" (the naive version claimed to have saved 1,212 games when 320 of them were merely played elsewhere, which is exactly the kind of number this repo does not ship). Then I timed it: 1,028-game run **10.40s sequential vs 13.46s with 6 workers** (SLOWER), and a realistic 7,326-game run **62.85s vs 59.15s** — **1.06x**. The estimate was wrong because the base arm is **1,600 of 7,326 games = 22%** of the work, not the ~31% a tiny run suggested, so even PERFECT base parallelism caps the whole command at 1.23x, and six workers each loading a 5,065-card pool spend most of that on startup. Reverted: a job kind, a worker handler, a cached per-worker runner, host accounting fixes and a new failure surface, for 6%, is complexity at a bad price. The `SuggestOptions.baseRecords` forward went with it — a seam with no consumer is speculative generality. ✅ WHAT WAS KEPT, because it is a real prerequisite and verified green: `runAdaptiveSearch` no longer builds its verdicts with `runner.summarize(handle)` (which reads the tally inside the HOST's runner) but from each arm's own accumulated tally through the same pure `summarizePairedSwap`. Identical numbers, and the report no longer requires the host to have played the games — the first obstacle to any pooled search, removed. ⚠️ THE STANDING CORRECTION FOR WHOEVER DOES THE FULL JOB: the value is in the VARIANT arms (78% of the work), there is no cheap partial version, and the only shape that pays is the full unification — an injectable arm executor so one loop serves both a synchronous handle and sharded slices.
- 2026-09-01 integrator: **MEASURED AND SPECIFIED, NOT BUILT — the CLI's `suggest` is the last big speed win, and it is ~5.6× (DESIGN §3.53 leftover).** 📊 `npm run sim -- suggest` runs **87 games/sec** SEQUENTIALLY while a parallel match on the same box does **485**. Every other command (match/gauntlet/swap/pilot-ab/soak) fans out; suggest still prints "note: --workers is not wired to suggest yet". It is also the product's headline feature, so this is the biggest user-facing speed number left anywhere in the repo. ⚠️ WHY IT WAS LEFT — and why that reason is now WEAKER THAN IT LOOKS: the adaptive search is round-stateful AND shares a BASE-ARM CACHE across candidates (the run above played 320 base games once instead of 320 per candidate, and skipped 252 variant games as provably identical), so naive per-candidate sharding would multiply the base work and lose more than parallelism gains. BUT the seam for shipping that cache across a worker boundary ALREADY EXISTS in the sim package and is already used by the web app: `PairedArmsOptions.baseRecords?: (slot) => PairedBaseRecord`, `PairedArmRunner.baseRecordAt`, and `toWireRecord`/`fromWireRecord` in `paired-arms.ts`. THE DESIGN IS ALSO ALREADY WRITTEN AND TESTED — `apps/web/src/lib/sim/run.ts` does exactly this, per round: **phase A** shards the shared base slots (`planBaseSlotShards`) and collects records into a host map; **a barrier** (phase B may not start until every base record exists); **phase B** shards the variant slices per candidate (`planVariantSliceShards`), each job carrying the base records for its slot range; a failed arm is dropped with a reason rather than killing a twenty-minute run. `determinism.test.ts` already proves that path byte-identical to `suggestSwaps` at 1 worker and at 12. ⚠️ THE WORK IS A MOVE, NOT AN INVENTION, AND MUST NOT BE A COPY: those planners live in `apps/web/src/lib/sim/plan.ts` against the web's own `ShardJob` protocol, so the CLI cannot import them. Duplicating ~150 lines of slot arithmetic into `parallel-slices.ts` would be the DRY violation this repo forbids — and two shard planners drifting apart would produce two different verdicts from one seed, which is the exact failure the byte-identity contract exists to prevent. The right shape is to lift the suggest sharding into `@jonny-boi/sim` (generalising the job types over the two transports) and have BOTH the web pool and the CLI worker host drive it, which is what §3.53 intended. Not started: it is a multi-hour refactor of the most safety-critical path in the product, and half-migrated is worse than not migrated. ⚠️ AND HERE IS THE CRUX, found by scoping the work and worth more than the rest of this note: **the two implementations are structurally different, not merely differently wired.** The sequential search in `suggest.ts` is HANDLE-BASED — it opens an arm per candidate, calls `runner.advance(handle, toGames)`, and builds every result at the end from `runner.summarize(handle)`, so the accumulated tally lives inside the HOST's runner. A pooled run cannot work that way: workers play the slices, the host's runner never sees those games, and `summarize` would report zeros. That is exactly why `apps/web/src/lib/sim/run.ts` accumulates the paired counts itself instead of being a thin wrapper around the sequential loop. So the job is to UNIFY the two shapes — give the search an injectable ARM EXECUTOR (sequential handle, or sharded slices) and build the report from accumulated counts either way — after which both transports drive one loop. `playSlice` already exists for precisely this ("the handle-free, resumable-from-anywhere form `advance` cannot offer, because a pooled run splits one arm's slots across several workers and no worker sees the whole arm"), so the PRIMITIVE is there and the shared CONTROL FLOW is what is missing. ⚠️ A SMALLER STEP THAT IS SAFE ON ITS OWN, if the full unification is not wanted: pre-play the BASE arm across workers and feed the records back through `PairedArmsOptions.baseRecords`. Base games were 320 of 1028 in the measured run (31%), the sequential loop then finds every one already cached, and the answer cannot change because a base slot is deterministic in its index — worth about 1.35x for one job kind, with the search itself untouched.
- 2026-09-01 integrator: **`feat/pilot-blocking` — a REFUTED hypothesis, kept on the record (§3.75). Do not re-try "hold attackers back for defence" without reading this.** NEW `bench/oracle-diff.mjs` drives a real game with the cheap pilot and asks the SEARCHING pilot for a second opinion at every window, so both judge the same on-policy positions. Over 2,457 windows with a genuine choice: the two agree on **99.0%** of decisions, and **EVERY disagreement is about attacking** — none about casting, blocking, land drops or abilities — with `lookahead` PASSING where the heuristic swings in 15 of 24 cases. That is a sharp, useful signal: the entire remaining gap between a one-ply policy and real rollouts sits in the attack step. THE HYPOTHESIS that followed — a one-ply policy cannot see the turn after, so it attacks with creatures it needed at home; `trimForDefence` dropped attackers until the counter-swing was survivable. 📊 VERDICT **WEAKER**: same harness as §3.74 (4,320 games, 2,160 matched slots) — ahead 18, **behind 39**, level 2,103, McNemar p = 8.1e-3. The code is deleted. ⚠️ THE LESSON IS NOT "LOOKAHEAD WAS WRONG": copying a searching pilot's CONCLUSION is not the same as having its REASONS. It declines those attacks because it evaluated THOSE positions; a rule that declines attacks SHAPED like them throws away races the pilot was winning. The evidence pointed at the right STEP and said nothing about the right RULE. ⚠️ AND THIS IS WHY THE A/B SEAM EARNS ITS KEEP: the hypothesis was plausible enough to ship on argument alone, every unit test still passed with it in, and it would have made the pilot quietly worse where nobody was looking — refuted for one parameter and one bench run. WHAT SURVIVES: `bench/oracle-diff.mjs`, and `bench/feature-ab.mjs` (generalised from §3.74's harness — takes `--feature <name>`, so the next hypothesis is one flag and one command away). STILL OPEN, and now known to be where the value is: WHICH attacks search declines. The shortlist is 24 windows; reading them one by one beats guessing another rule from their shape. Verify 19,369 passed, 0 failed.
- 2026-09-01 integrator: **`feat/pilot-strength` — the FIRST measured strength gain: the pilot now takes a win it can prove (§3.74)**. Where to look came from data: NEW `bench/missed-plays.mjs` asks the ENGINE what a seat could still legally have done, so a "missed play" is one the menu really offered — land drops left unused **0.0%**, main-phase passes with a castable spell **0**, attack windows declined **15.0%**. Combat was the only open surface. THE BUG: `chooseAttack` judged every attacker INDEPENDENTLY and never asked about lethal, so three 2/2s into one 4/4 were declined one at a time — while the 4/4 blocks only ONE, two connect, and at 4 life that is the game. `lethalAlphaStrike` assumes the defender's best case throughout (each untapped creature blocks one attacker per CR 509.1, they block the BIGGEST, only the remainder connects) and deliberately under-claims: a creature that could not legally block is still counted as a blocker, and tricks/prevention/lifegain are ignored — each of those makes it refuse an attack that was really lethal, a missed win rather than a thrown game. 📊 VERDICT, head-to-head against the pilot exactly as it was before (`bench/alpha-strike-ab.mjs`, 9 decks × 36 pairs × 60 games × both orientations = 4,320 games): matched slots 2,160, **ahead 64 · behind 0 · level 2,096**, McNemar **p = 3.6e-15**, verdict STRONGER. ⚠️ READ IT CORRECTLY: the arms play the SAME game in 2,096 of 2,160 slots because the case is rare, and in every one of the 64 where it arose the new behaviour converted it. The raw win share (51.4%) is the WRONG number to quote — it is diluted by thousands of identical games. ⚠️ WHY THERE IS A FLAG: two BUILDS of one pilot cannot be compared across branches (same id, only one loads, and the same-id control is 50% on both by construction), so `HeuristicFeatures.alphaStrike` puts both behaviours in one process on matched seeds. It stays so the claim stays re-checkable — an A/B seam, not a config knob. ⚠️ AND THE CONTROL MUST BE REAL: the first `alpha-strike.test.ts` built its board without initialising `state.combat`, so the engine offered no `declareAttackers` at all — every arm "declined to attack" and the control passed while proving nothing. The fixture now asserts the menu offers the attack before asking what the pilot does with it. 📊 HOW MUCH ROOM IS LEFT: `lookahead`, which searches real engine rollouts, beats the heuristic on matched slots 42–10 with **88% of slots LEVEL** — the heuristic is already close to what this engine's search finds, so strength comes one proven case at a time, not from a rewrite. Verify 19,369 passed, 0 failed.
- 2026-09-01 integrator: **`feat/pilot-fastpass` — stop building a menu nobody reads (§3.73). Cumulative +48% on a 3,000-game match.** The measurement is the design: 592 decision windows per game, the pilot passes **81.7%** of them, and `tapForMana` is **73% of every action ever offered**. Four windows in five the engine enumerated a full menu, the pilot scored it, and it was discarded. NEW SEAM `Pilot.willPassPriority` — a pilot answers from the STATE ALONE that it will pass whatever the menu holds, and the harness applies the pass without calling `generateLegalActions` at all. ⚠️ IT IS A PROMISE, NOT A HINT: nothing checks the answer afterwards, so a wrong `true` makes the pilot play worse in every recorded win rate, silently. The contract is one-sided — `false` is always safe — and the gate refuses on a parked question, a non-empty stack, a combat declaration or a live card grant, then compares the cheapest thing playable IN THIS WINDOW (respecting timing, cycling, flashback's own speed, land-drop availability) against an UPPER BOUND on mana (pool + untapped sources). The bound over-estimates deliberately: over-estimating only ever forces the menu to be built anyway, under-estimating would skip a window the pilot could have acted in. ⚠️ THE GUARD IS THE POINT — `packages/sim/src/fast-pass.test.ts` plays whole games with the seam on and off (3 archetypes × 12 seeds × both seats) and requires the DECISION TRACES to be identical action for action, not merely the same winner; a second test checks the promise window-by-window against the pilot's real choice and requires the gate to fire 100+ times, because "it never lied" is a claim about nothing if it never speaks. 📊 Gate fires on **49.8%** of windows — a first version managed 1.6%, because it refused whenever the graveyard was non-empty (85% of the time) when the useful question was "is there an INSTANT-SPEED flashback card there". Single-thread 174 → **195–204 games/sec**; auto path 3,000 games 469 → **485**, 6,000 598 → **622**, 20,000 764 → **795**. With §3.72 that is **327 → 485 (+48%)** at the size the tool is actually used. ⚠️ STILL NOT 10×: pilot `decide` 33.9%, `applyActionToDraft` 32.7%, `generateLegalActions` 19.9% — ~87% in three blocks, and this halves one of them. The rest needs an apply cheaper than a draft clone, and legal actions generated incrementally rather than rebuilt per decision. Verify 19,364 passed, 0 failed.
- 2026-09-01 integrator: **`feat/pilot-speed` — the sim was hiring workers that made it SLOWER (§3.72). Auto path +43% at 3,000 games.** Measured first, on the reference box (12 hardware threads, 6 PHYSICAL cores), 6,000-game match: workers 2→343, 3→463, 4→551, 5→575, **6→593**, 8→559, 11→516 games/sec. Throughput peaks at the PHYSICAL core count and falls off after it — and auto mode was hiring 11. Two stale constants and one dead one: `availableParallelism()` reports hardware THREADS and the policy spent them as cores (this workload is compute/allocation-bound — each worker holds its own 5,000-card pool — so SMT siblings contend rather than overlap), `AUTO_GAMES_PER_WORKER = 150` was calibrated when the sim ran at "double-digit games/sec" with "~1–2s" startup and today it is ~0.35s startup against ~180 games/sec single-threaded (so 150 games = 0.8s of work, and auto hired workers that could not pay for themselves — now 400), and `HOST_RESERVED_CORES` is DELETED because folding by SMT already leaves the host a thread and taking a whole core off measured strictly worse (5 workers 575 vs 6 workers 593 at 6,000; 723 vs 765 at 20,000). 📊 AUTO PATH BEFORE → AFTER: 3,000 games 327 → **469** (+43%), 6,000 games 516 → **598** (+16%), 20,000 games 758 → **764**. A win at every size and biggest where the tool is actually used. ⚠️ NEW TOOLING YOU WILL NEED: `packages/sim/bench/pilot-bench.mjs` runs games IN PROCESS — `npm run sim -- match` plays them in a worker, so `node --cpu-prof` on the CLI profiles a parent that is 99% IDLE and the top entries are the module loader. Do not profile the CLI. `bench/window-stats.mjs` reports what a decision actually looks like, and the answer is the map for the next slice of work: **592 decision windows per game, the pilot PASSES 81.7% of them, `tapForMana` is 73% of every action ever offered (128,349 of 174,963), and only 27.4% of windows offer nothing but a pass.** ⚠️ THIS IS NOT 10× AND IS NOT CLAIMED TO BE: the in-process profile reads pilot `decide` 33.9%, `applyActionToDraft` 32.7%, `generateLegalActions` 19.9% — ~87% of the run in three blocks, so an order of magnitude needs all three restructured. The window statistics say what that restructuring is: the engine builds a full menu, dominated by mana taps, for a pilot that passes four times in five. Verify 19,362 passed, 0 failed.
- 2026-09-01 integrator: **`feat/full-pool` GREEN AND MERGED — the app ships 573 → 5,065 cards, and the bigger pool found SEVEN latent bugs (§3.71)**. ⚠️ FIRST, DISTRUST EVERY EARLIER COVERAGE NUMBER: the corpus filter decided "is this a paper card?" from the ONE printing `oracle-cards` carries, and Scryfall picks it — for Black Knight, Capsize and Weakness it picks an MTGO-only reprint, so both a `games.includes('paper')` and a `digital !== true` filter dropped cards that have been in paper since Alpha. The search-API version of the same mistake (`is:digital -is:paper` is a PRINTING predicate) matched an MTGO printing of **Plains** and deleted the basic land. `in:` is the card-level prefix; `-in:paper` = **874** never-on-cardboard cards, not 7,369. Corpus 31,091 → **32,276**, i.e. ~1,185 real cards were missing from every measurement before this. THE BUGS, each fixed with a test: (1) `tap: true` was being written into `ManaAbilityCost`, a field that does not exist — it survived because the generated array literal had no contextual type to excess-property-check against, and only TS2590-forced chunking gave it one; (2) `Number.parseInt('-0')` is NEGATIVE ZERO and `JSON.stringify(-0)` is `"0"`, so Befuddle's "-4/-0" could never round-trip through the generated pool — now one `parseSignedInt` for all twenty parse sites; (3) the heuristic BUILT its own `activateAbility` without `costInstanceIds`, so every sacrifice-cost ability it chose was rejected unpayable — it now takes the engine's own offer; (4) `planManaPayment` dropped the additional-cost payer and five call sites rebuilt `tapForMana` from `{instanceId, mode}`, so Springleaf Drum and Phyrexian Tower were refused mid-game — one `tapActionFor` builder now owns that shape; (5) ⚠️ TOKEN-NESS WAS TREATED AS A COPIABLE VALUE (CR 707.2): a Glasspool Mimic copying a Thopter token inherited `isToken`, and `ceaseToExistIfToken` then removed **a real card from every zone** when it died — the soak caught it as "original instance #61 is in no zone on turn 37"; (6) the land-drop audit compared against `maxLandsPerTurn` while Exploration legally raises it — both audits now ask the engine's `maxLandPlaysFor`; (7) two compile rules superseded by the §3.60 conjunction helper matched no card while naming cards they claimed to compile. GUARDS WERE RE-TIERED, NOT DROPPED — three assumed a hand-picked pool and would have gone permanently red: attachments keep human transcription for named cards and everything else must match a reading taken independently from its Oracle text (200 attachments, 3 disagreements, all three the second reader's fault); the mana-source cap is now read off each card's own printed "Add …" line instead of "2, except two cards by name"; and `uncounterable` went inert because the opponent deck ROTATES and the rotation moved off counterspells, so `enablerBelongsToOpponent` now declares the pairing rather than leaving it to the length of a list. PWA: pool and index are their own rollup chunks and workbox's 2 MiB precache cap is raised with the trade stated (precache 5.7 MB) — an offline deck lab that cannot open a card offline has precached the wrong things. 📊 Throughput 179/180 games/sec vs 169/170 on this branch before the fixes — no regression. Verify 19,362 passed, 0 failed.
- 2026-09-01 integrator: **`feat/full-pool` — IN FLIGHT, NOT MERGED. The shipped pool goes 573 → 5,065 cards, and the corpus filter was lying.** ⚠️ READ THIS BEFORE TRUSTING ANY EARLIER COVERAGE NUMBER: `fetch-full-corpus.mjs` decided "is this a paper card?" from the ONE printing `oracle-cards` happens to carry, and Scryfall picks that printing. For Black Knight, Capsize and Weakness it picks an MTGO-only reprint, so `games` had no 'paper' and `digital` was true — for cards that have been in paper since Alpha. Both filters dropped them silently, and the search-API version of the same mistake (`is:digital -is:paper`, a PRINTING predicate) matched an MTGO printing of **Plains** and removed the basic land. The card-level prefix is `in:`, and `-in:paper` is the honest question: **874** cards never printed on cardboard, not 7,369. Corpus 31,091 → **32,276**; every number reported before this was computed against a corpus missing ~1,185 real cards. WHAT LANDED ON THE BRANCH: a `--corpus` phase for `build-expansion.ts` and a `--corpus` flag for the data-tools pipeline, so BOTH the pool and the card index build OFFLINE from one bulk download instead of thousands of paged requests (the corpus now carries `set`/`rarity`/`image_uris` for exactly that). The invariant that makes it safe: **the index owns ids, the corpus owns everything else** — a bulk corpus carries one arbitrary printing, so re-picking would rewrite Plains' id out from under `pool.ts`, and preserving whole ROWS (the first attempt) made the index and the pool compile from different Oracle text. BUGS THE BIGGER POOL EXPOSED, all fixed here: `tap: true` was written into `ManaAbilityCost`, a field that does not exist — it survived only because the generated array literal had no contextual type to excess-property-check against (TS2590 forced chunking, chunking gave it a type, the type found the phantom); `Number.parseInt('-0')` is NEGATIVE ZERO and `JSON.stringify(-0)` is `"0"`, so Befuddle's "-4/-0" could never round-trip through the generated pool — now one `parseSignedInt` helper for all 20 parse sites; the equip-timing test read `activated[0]` and failed on Lead Pipe, whose sacrifice ability is printed first; and Delver of Secrets was authored AND compiled because a double-faced card is stored under its combined name in one place and its front half in the other. The attachment guard was re-tiered rather than abandoned: named cards keep their HUMAN transcription, every other attachment must match a reading taken independently from its Oracle text (a different regex, written from the card face) — 200 attachments, 3 disagreements, all three the second reader's fault and documented. PWA: the pool and index are their own rollup chunks and workbox's 2 MiB precache cap is raised with the trade stated, so the shell still paints before 5,065 definitions parse. ⚠️ STILL RED, and each needs judgement rather than a constant bump: a card somewhere in the 5,065 emits `effectUnsupported` in the resolve-everything soak; `Apprentice Wizard` adds 3 mana against a guard that caps a mode at 2; the observation feed no longer fires every mechanic the pool prints; one wrapper primitive prices its body as empty (the §3.42 shape); and `generateCandidates` counts 10,198 where it expects 10,200. `main` is untouched and green.
- 2026-09-01 integrator: **`feat/convoke2` — Convoke, Improvise and Delve are ONE mechanic (§3.70). +70 cards, 4,793 → 4,863**. Convoke was #1 on the honest backlog by BOTH measures (46 by mechanic, 46 by clause shape — the two tools agreeing for the first time), and it was built as the class: all three are a RESOURCE the caster owns (untapped creature / untapped artifact / graveyard card), CONSUMED a particular way (tapped / tapped / exiled), each paying one mana toward this spell. The only real difference is whether one resource can cover a COLOURED pip — convoke's creature pays "{1} or one mana of that creature's color", the other two pay generic only — which is one boolean in the closed `COST_ASSISTS` table, not a branch. A fourth mechanic of this shape is a ROW. Predicted 46+12+12=70 and delivered exactly 70, because all three print as bare keyword lines with the rule in stripped reminder text. ⚠️ THE ASSIST IS THE MINIMUM, NEVER THE MAXIMUM — all three are optional and the resources are expensive (a convoked creature can't block, a delved card is gone), so a planner that consumed everything it legally could would obey the rules while throwing the game. It asks `canPay` after EVERY step and returns undefined when the pool already pays. ⚠️ COLOURED PIPS ARE ASSIGNED FIRST: only a resource of that colour can pay one, so spending the green creature on generic and then finding {G} unpayable is the ordering bug this avoids. Offer and pay share the planner — `pushCastOffers` asks only on the branch that was about to refuse (a board with no assist card pays one property read), `applyCastSpell` re-plans from the live board and checks mana against the plan's own `remaining` BEFORE tapping anything. ⚠️ TWO HONEST LIMITS, both legal CHOICES rather than approximations: a hybrid pip is left to real mana, and the one card printing "Convoke, delve" REPORTS instead of compiling to one of the two. Declining to convoke a pip is always legal, so the engine is occasionally more conservative than a perfect pilot and can never play BETTER than the printed card. 📊 No perf regression: 2,000-game single-worker match (Mono-Red vs UW Control, seed 7, heuristic) reads 169/170 games/sec here against 158/159 on main — measured in different worktrees, so the honest claim is parity, not a speed-up. Verify 5878 passed, 0 failed.
- 2026-09-01 integrator: **`feat/affinity` — the first pick off the HONEST backlog (§3.69)**. With ability-word labels folded away, both reports agreed Affinity was the biggest unimplemented mechanic needing no new payment machinery. Predicted 28 cards, **delivered 22** (4,771 → 4,793 of 31,091) — the smaller number is the real one; the rest carry a second gap too. NEW `CardDefinition.castCostReductionPerPermanent`, deliberately SEPARATE from `castCostReduction`: that one is a grant a PERMANENT makes and is found by walking the battlefield, this one is printed on the SPELL and scales with a board count. Folding them together means either walking for a reducer that is never there, or reading a spell in hand as though it were on the battlefield — the second is how a card reduces its own cost from the graveyard. ⚠️ THE TRAP WAS THE EARLY RETURN: `castManaCostFor` bailed when the caster controlled no reducing permanent, which is right for a grant and fatal for affinity — it would have charged full price on exactly the empty boards where affinity is why you are casting the spell. ONE rule matches both printings (the keyword line and the longhand "costs {1} less to cast for each artifact you control"), with a test asserting they compile to identical data, and `amount` is named rather than assumed so a "{2} less for each" wording has somewhere honest to go. ⚠️ "Affinity for Slivers" REPORTS rather than compiling to "for each creature" — a creature-type affinity would make the spell dramatically cheaper than printed. Verify 5870 passed, 0 failed. NEXT, by the same data: Convoke (46 cards, #1 by both mechanic and clause shape), which needs the real thing — cost ASSISTANCE, shared with Improvise (12) and Delve (12).
- 2026-09-01 integrator: **`feat/ability-words` — the measurement was lying, and fixing it found a real bug (§3.68)**. ⚠️ READ THIS BEFORE TRUSTING A GAP REPORT: `keyword-gap-report.mjs` was substring-matching Scryfall's keyword tags against the blocking clause, so every Aura whose grant BODY was unsupported ("Enchanted creature can't attack or block") was filed as a missing **Enchant** keyword — 412 cards deep, pointing at a system this engine has had for as long as it has had Auras. Two further attributions were tried and failed the OTHER way (exact-match on the compiler's sweep reason missed every keyword whose printed line simply matched no rule, and claimed the whole pool had 12 keyword-blocked cards). The honest test, now in the script's header along with all three failures: THE BLOCKING CLAUSE IS THE KEYWORD'S OWN PRINTED LINE — the clause starts with the keyword at a word boundary. "Enchanted" is not the word "enchant", so case 1 cannot creep back. With that fixed the top of the backlog was ABILITY WORDS, and CR 207.2c says those have no rules meaning at all: `joinRevoltRiders` was gluing EVERY ability-word line onto the line above it, so "Flying" + "Revolt — When this creature enters, …" became one sentence no rule can match. A rider is now detected by being UNABLE to stand alone (a dangling demonstrative, or an "instead" in its OWN first sentence on a line that opens no ability) — Akoum Hellkite is why that last qualifier exists. The ability-word vocabulary is a closed table DERIVED FROM THE CORPUS, and deliberately excludes Saga chapters, Channel, Exhaust, Boast, Bloodrush, Forecast, Companion, Max speed, To solve/Solved and Eminence, which wear the same italic-word-then-dash shape while carrying real rules. 📊 HONEST NUMBER, SMALLER THAN THE HEADLINE: 4,757 → 4,771 playable (+14), not the ~450 the old attribution implied — stripping a label exposes the BODY, and most bodies are still unimplemented. Kept for the measurement, not the count: the two independent tools now AGREE on what is next (Convoke, 46 cards, ranked #1 both by mechanic and by clause shape) where they used to disagree thirtyfold. Verify 5864 passed, 0 failed.
- 2026-09-01 integrator: ⚠️ **CORRECTION to the two perf notes above, and the measurement trap that caused it.** I reported +15% and +17% from 200–300-game matches. Those runs are DOMINATED BY PROCESS STARTUP (tsx compile ≈1.5s against ≈2s of work), so a fixed cost read as a throughput difference. Re-measured at 2,000 games, which amortises it: **pre-perf ≈263 games/sec, now ≈285 — a real +8%, not +17%.** The three changes are still right (the O(board²) offer loop was my own regression, the reducer walk was genuinely per-card, and the pilot was rebuilding a board index the decision context already carried), but the honest figure is 8%. **NEVER benchmark this sim below ~1,000 games**, and prefer an A/B where both arms run in the same session. The 10× target therefore stands at ≈285 → ≈2,850 games/sec, against an inclusive profile of pilot-decide 33% / engine-apply 32% / legal-actions 18%.
- 2026-09-01 integrator: **`feat/regenerate` — the top-ranked missing MECHANIC, chosen by the report, worth +55 whole cards**. `keyword-gap-report.mjs` put Regenerate at **129 cards blocked by it alone**, the highest unimplemented named mechanic; the full-pool audit re-run after the branch reads **4,702 → 4,757 / 31,091 playable**, so 55 cards flipped and the other 74 need a second system too (the report names which). Built as CR 701.15 actually reads — a REPLACEMENT for the next destruction this turn: remove all damage, TAP, and remove from combat, all three pinned by tests, because a shield that only cleared damage would let a regenerating blocker keep blocking. ⚠️ TWO DEATH ROUTES, ONE FUNNEL: lethal-damage SBA and the `destroy` primitive both call the same exported `consumeRegenerationShield` — had only one consumed shields, half of Magic would regenerate and the other half would not. The primitive calls it AFTER the indestructible check on purpose: indestructible is a different replacement that wins outright and must not burn a shield it never needed. Shields are a COUNT, not a flag (two activations before blockers = two shields), cleared in CLEANUP because the shield lasts "this turn" and no longer. Guards fed as usual: `regenerated` classified in instance-ids / SOURCE_SET_EVENTS / observation / soak-config (new mechanic id `regeneration`), `regenerate` classified LIBRARY-SAFE in paired-arms (it writes a shield count on a battlefield permanent and reads no zone) and priced in `effect-value.ts` against the best creature the pilot would regret losing. Live probes: Darkling Stalker, Troll Ascetic, Wall of Pine Needles, Thrun the Last Troll — all COMPLETE. Verify 5857 passed, 0 failed.
- 2026-09-01 integrator: **`feat/pilot-perf-2` — +17% cumulative, and the INCLUSIVE profile that says where 10× has to come from**. Two safe wins: cast-cost reducers are now walked ONCE per offer pass instead of once per candidate card (deliberately NOT cached across calls — the engine mutates the draft battlefield in place, so any cache keyed on it would have to prove nothing relevant changed; threading is the same saving with nothing to invalidate), and the heuristic skips its whole spell-scoring pass in a window where nothing is castable. Single-worker throughput 149 → 172 games/sec; the 200-game match reads ~121 → ~141 (heuristic) and ~117 → ~134 (lookahead), 3-run means. ⚠️ THE HONEST SHAPE OF THE 10× GOAL, from an INCLUSIVE-time profile (self-time rankings mislead here): pilot decide **33.3%** (choosePriorityAction 27.0, bestSpellGoal 19.1, scoredSpellGoals 11.7), engine apply **32.1%** (dispatchAction 22.9, onPassPriority 13.4), generateLegalActions **17.6%**. Those three are ~83% of the run, so 10× requires all three to shrink by roughly an order of magnitude — micro-optimisation cannot get there. The candidate structural moves, in the order the data supports: (1) stop re-deriving the whole spell-goal ranking on every priority window; (2) make an action's apply cheaper than a full draft clone; (3) generate legal actions incrementally rather than from scratch per decision.
- 2026-09-01 integrator: **`feat/pilot-perf-1` — the FIRST throughput measurement, and a regression I caused, both from the profiler**. Baseline before: heuristic 121 games/sec, lookahead 117 (Mono-Red vs UW Control, 200 games, seed 7). A `--cpu-prof` run over 3,000 single-worker games showed my own `feat/granted-abilities` reading each permanent's grants through `aggregateFor` INSIDE the ability-offer loop — and `aggregateFor` walks the battlefield per call, so the loop was O(board²) per action (5.2% of the whole run). Replaced by ONE index per `generateLegalActions`, gated by the `anyContinuousModification` check that already existed for exactly that question. Now heuristic **139 games/sec (+15%)**, lookahead **131 (+12%)**. Profile's remaining hot path, for whoever takes the next slice: `generateLegalActions` 10.2%, `scoredSpellGoals` 3.9%, `applyActionToDraft` 3.5%, `choosePriorityAction` 3.1%, `planManaPayment` 3.0%, `bestSpellGoal` 2.9%, `rememberSources` 2.6%. ⚠️ LESSON: adding a per-permanent read of a battlefield-walking helper is the standard way to turn a linear loop quadratic — the gate to reuse is almost always already there.
- 2026-09-01 integrator: **`feat/granted-abilities` MERGED + DEPLOYED — and the measurement base moved to the REAL pool**. NEW `scripts/fetch-full-corpus.mjs` pulls Scryfall's bulk `oracle-cards` (one request, JSONL, gunzipped locally) and keeps **31,091 paper non-joke cards** — excluding `set_type: funny`, digital-only (Alchemy/Arena), token/emblem layouts and Jumpstart `front_card` theme cards, each for a stated reason. **The honest full-pool baseline was 4,678/31,091 = 14.9% playable**, not the 671/2100 the modern-legal sample suggested. NEW `scripts/keyword-gap-report.mjs` ranks unimplemented MECHANICS by cards blocked. Against that data the biggest coherent system was GRANTED ACTIVATED ABILITIES (374 cards blocked by it alone): `PermanentModification.activated` (an anthem-shaped grant), folded by the existing continuous layer, read by ONE new accessor `effectiveActivated` that BOTH the ability offer path and the apply path now call — `abilityIndex` indexes exactly that list, and two readers disagreeing about index 1 activates the wrong ability. The quoted ability compiles through the compiler's OWN activated-ability parser (`RuleContext.compileQuotedAbility`), so a granted ability can never do what a printed one could not. ⚠️ HONEST LIMIT: a granted MANA ability ("…have \"{T}: Add one mana of any color.\"" — Cryptolith Rite, Chromatic Lantern, Paradise Mantle) is still REFUSED: mana abilities are read from a DEFINITION (`manaModesOf`) rather than from an instance+mod, so granting one is a separate, wider change. The conformance witness that proves modifications are purely additive was extended to `activated` with the reason it qualifies (it APPENDS; printed abilities keep their indices).
- 2026-08-29 integrator: **`feat/near-miss-4` MERGED + DEPLOYED — "that much" (666 → 670)**. Measured ten one-mechanism families; the life-trigger family led at 7 one-clause cards. Two pieces, both general: (1) a `lifeLoss` TRIGGER — keyed on `lifeChanged` with a NEGATIVE delta, because the engine emits no `loseLife` event, and that keying is also the CORRECT one: CR 118.3 counts damage as life loss, which is exactly what Exquisite Blood means; (2) an AMOUNT CHANNEL: `triggeringAmount` travels pending-trigger → stack object → resolution frame → EffectContext beside `triggeringPlayer`, and is read through the derived-value name `triggeringAmount` at the `intParam` seam — so EVERY numeric param in the library understands "that much" without a single primitive changing. The printed bodies are a TABLE (`TRIGGERING_AMOUNT_BODIES`): the next "…that many cards" wording is a row, and "that much" cannot come to mean two quantities. Vito, Sanguine Bond, Exquisite Blood, Bloodthirsty Conqueror, Mindcrank compile. A real-game test drains 3 and asserts the gain is EXACTLY 3 — a life-TOTAL read would answer neither question after a gain-then-loss.
- 2026-08-29 integrator: **`feat/graveyard-hate` MERGED + DEPLOYED — 650 → 666 playable (+16), the biggest measured family yet**. Measurement first: the graveyard-exile family looked like the pick (9 one-clause cards), but probing it surfaced a BIGGER neighbour — **26 one-clause cards blocked by a `Sacrifice a <noun>` ACTIVATION cost** (Viscera Seer, Goblin Bombardment, Carrion Feeder, Zuran Orb, Scavenger Grounds, Fountainport…). Built both. (1) `exileGraveyard` reading the shared `playersForParam` scope vocabulary — "target player's" / "all" / "each opponent's" are param values, not primitives. (2) `ActivationCost.sacrificeAnother` + `sacrificeExcludesSelf`, paid at ACTIVATION (CR 602.2b) with the payer named by `ActivateAbilityAction.costInstanceIds` — there is no resolution in which to ask, so the generator offers ONE ACTION PER LEGAL PAYER, exactly as the mana-ability cost does. DRY: the mana table `MANA_COST_NOUNS` was RENAMED `COST_NOUNS` and is now read by BOTH cost parsers, so "a Treasure" cannot mean one thing on Gilded Goose and another on Professional Face-Breaker; a test pins that sharing across both forms. HONEST LIMIT: a count above one ("Sacrifice two artifacts") is still REFUSED — the offer menu enumerates a single payer, so compiling it would silently narrow the player's choice to the first legal pair. ⚠️ All four guards fired on this branch and all four were right: paired-arms classification, AI value parity, the instance-id ledger (`costInstanceIds`), and a stale refusal probe pinning "sacrifice a creature" as unpayable.
- 2026-08-29 integrator: **`feat/near-miss-3` MERGED + DEPLOYED — one meaning for "A and B" (645 → 650)**. A DRY defect, not a missing feature: `compileConjunction` already existed but ONLY `compileTriggerBody` called it, so the identical printed sentence compiled inside a trigger and REPORTED on a spell's own line. Now the spell-line compiler and the nested-clause compiler call the same helper, and a test pins that sharing (the same sentence, both places, same refs). ⚠️ HONEST NUMBER, per rule 11: a text scan suggested 49 candidate cards; the strict test (BOTH halves must compile alone) predicted 5; the actual corpus delta was 5. Kept for the shared meaning, not the count — and the 49 is recorded here so nobody re-measures it as a win. Also note rules 10-12 landed in CLAUDE.md this session (systemic / measured / DRY), each citing the tooling that enforces it.
- 2026-08-29 integrator: **`feat/near-miss-2` MERGED + DEPLOYED — 638 → 645 playable, again chosen by measurement**. Re-ran `near-miss-report.mjs` (948 cards one clause from playable), then measured NINE candidate families before writing anything: the mana-ability-additional-cost family led at 18 one-clause cards. Drilling in with a second measurement SHRANK the honest estimate — most of that 18 was a grab-bag of unreadable PAYLOADS (commander identity, devotion, "for each Swamp"), not costs; the real cost family was 7-8. Built that: `ManaAbilityCost.tapAnother` / `sacrificeAnother` (a CardFilter each) + a closed `MANA_COST_NOUNS` table the tap form and the sacrifice form share. **The payer rides the ACTION (`TapForManaAction.costInstanceId`), not a parked question — a mana ability resolves immediately and may not park one (CR 605.3a)** — so the generator offers ONE ACTION PER LEGAL PAYER, exactly as it already does per colour MODE. Also NEW `ManaAbilityCost.noTap`: an explicit opt-out, because several rich abilities that DO print {T} carry no `tap` flag, so inferring it from absence would untap the whole pool — and the difference is real (Skirk Prospector activates repeatedly). Springleaf Drum, Scene of the Crime, Survivors' Encampment, Relic of Legends, Gilded Goose, Phyrexian Tower, Skirk Prospector all compile. ⚠️ TRAPS: (1) a new ACTION field holding a card id must be classified in `instance-ids.ts` or the protocol leak scanner walks past it — its guard named the field; (2) another stale refusal probe flipped (mana-templates pinned Springleaf Drum as impossible).
- 2026-08-29 integrator: **`feat/near-miss` MERGED + DEPLOYED — 625 → 638 playable (+13) from ONE data table, chosen by measurement**. NEW `scripts/near-miss-report.mjs`: of 2100 corpus cards, 1475 are incomplete and **958 are blocked by EXACTLY ONE clause** — it clusters those by clause SHAPE (numbers/quotes/names collapsed), turning the long tail into a work queue ordered by cards-per-edit. I also MEASURED two hypotheses before writing code and killed one: a general top-level " and " conjunction splitter would have unblocked only 5 cards (not worth the ambiguity), while the removal-noun family was worth 13. The fix is data, not rules: ONE `TARGET_NOUN_RESTRICTIONS` table (+ a spell-noun sibling) that destroy / exile / counter all read, so the next printed noun is a ROW plus its core restriction, understood by every verb in the same edit. Five new core restrictions (artifactOrCreature, creatureOrEnchantment, nonartifactCreature, nonlandPermanent, noncreatureSpell, instantSpell). ⚠️ TRAPS, both caught by existing guards rather than by me: (1) a new restriction must be added to BOTH the legality arm and the ENUMERATION arm — the §3.36 zoo-board test named the exact member and the exact disagreement; (2) widening a shared table can SILENTLY STEAL a card from a dedicated rule — "artifact, enchantment, or land" has two printed comma spellings and the dedicated rule owns both, so that noun is deliberately NOT in the table (the §3.57 rule-coverage guard caught the theft the moment it happened).
- 2026-08-29 integrator: **`feat/pact-upkeep` MERGED + DEPLOYED — the Pact bill; Pact of Negation compiles**. This was the LAST card the dead-rule sweep flagged whose blocker was a real missing system rather than a rule bug. Two composable primitives: `scheduleDelayedPayment` (as the free spell RESOLVES, schedule the upkeep bill — a Pact is an instant already in the graveyard when it comes due, so nothing on the battlefield could carry the trigger; `{on:'upkeep',who:'you'}` on a DELAYED ability IS "your next upkeep", since a delayed ability fires once and is removed) and `payManaOrElse` (the bill: pay, or the consequence refs run). The consequence compiles through the ordinary table — a printed "if you don't, sacrifice it" is a rule-table entry, not engine work. NOT a "you may": declining is not free, and an empty pool is a decline, or the card is a free counterspell. AI prices the bill by affordability and the schedule as a banked cost. TRAPS: (1) the parity guard caught both new primitives unpriced — it works, price them rather than ledger them; (2) a `new RegExp(`…`)` template forces double-escaping that lint flags as useless — write a plain regex literal when nothing is interpolated. Corpus 624 → 625/2100; suite 5777.
- 2026-08-27 DESKTOP-90PJPM4 (integrator): `fix/native-drag-hijack` — §3.54, the land-play killer.
  §3.51's full-face <img> was natively draggable; a press-plus-wobble started a BROWSER image drag,
  cancelling our pointer machine AND eating the click. Clip-proven (three mousedowns, no mouseup).
  ⚠️ Synthetic pointers can NEVER catch this class — the structural pin renders PlayCard and
  requires draggable="false" on every img. If you add an <img> anywhere near a gesture surface,
  set draggable={false} or the no-native-drag test will (rightly) fail.

# Agent coordination (multiple agents, multiple machines)

**jonny-boi** is built by several Claude agents — **including agents on different machines** that all
push to one repo. This file is the **shared cross-machine channel**: the repo is the only thing every
agent sees. Read it at the start of a session; update your section before you push.

## Hard rules (prevent two agents clobbering each other)
1. **`git fetch` before you integrate or push.** Never `git push --force` to `main`. Integrate by
   merging the latest `origin/main` first.
2. **One feature per branch, each in its own git worktree** (`feat/<slug>` / `fix/<slug>`), owning a
   **disjoint package** (DESIGN.md §6). Check this file's in-flight table + `git branch -r` before
   claiming work so two agents don't grab the same files.
2b. **Pick a unique branch slug.** If a `feat/<slug>` already exists on the remote, choose another.
2c. **NEVER `git checkout` in the primary checkout `D:\Cool Stuff\Claude\jonny-boi`.** It belongs to the
   integrator and must stay on `main`. Work ONLY inside the worktree your brief names. This has now
   broken three times, and the failure is silent and expensive: your commits land on whatever branch
   you switched to, `git push origin main` then pushes the *stale local* `main` ref, and git reports
   `non-fast-forward` / "branch tip is behind" while `git rev-list HEAD..origin/main` says you are 0
   behind — a contradiction that wastes a long debug. **Before committing anywhere, run
   `git rev-parse --abbrev-ref HEAD` and confirm it is the branch your brief assigned.** If you find
   the primary checkout on the wrong branch, say so in your report; do not "fix" it mid-task.
3. **Workers push branches; they do NOT merge to `main`.** One **integrator** merges reviewed green
   branches to `main`, ships, and publishes the build.
4. **Know your build configs.** `npm test` (Vitest) judges green by "N passed, 0 failed"; the shippable
   artifact is `npm run build`.
5. **Definition of done** (DESIGN.md §7): feature + tests, full suite green, DESIGN §3 flipped,
   committed with **explicit paths** (never `git add -A`), pushed.

## Ship / release process (integrator)
Per landed feature/batch: merge → `npm run build` + `npm test` green → the build auto-publishes. Keep sim
throughput (games/sec) from regressing.

### Live build (always-latest, mobile-accessible)
- **URL: https://cjacobscoding.github.io/jonny-boi-app/** — the PWA, installable on phone + desktop.
- This source repo is **private** (GitHub Pages unavailable on Free plan for private repos), so the built
  static site is mirrored to the **public** repo `cjacobsCoding/jonny-boi-app` (gh-pages branch → Pages).
- **Auto-deploy:** `.github/workflows/deploy-pwa.yml` runs on every push to `main` — `npm ci` →
  `npm run build` (with `DEPLOY_BASE=/jonny-boi-app/`) → mirrors `apps/web/dist` to the public repo via a
  write-scoped SSH deploy key stored as the `ACTIONS_DEPLOY_KEY` secret. No manual step; every merge ships.
- The web app's Vite `base` + PWA manifest scope read `DEPLOY_BASE` (default `/` for local `npm run dev`).

## Roles
- **Integrator** — `DESKTOP-90PJPM4` (supervisor on this machine merges to `main` + ships).
- **Workers** — _(other machines / dispatched agents; add your hostname + branch when you join)_

## In-flight / ownership  (update when you start or finish)

| branch | owner / machine | files owned | status |
|--------|-----------------|-------------|--------|
| feat/lab-trim | worker (jb-trim) | **packages/sim**: NEW `src/trim.ts` + `src/trim.test.ts`; `src/swap.ts` (ADDITIVE: `SWAP_IN_NOTHING`, `CUT_OUT_SEPARATOR`, `isCut`, `cutOutRefs`, a cut path at the top of `applySwap` + `applyCut`, a cut branch in `copiesSwappedBy`); `src/index.ts` (one export block). **apps/web**: NEW `components/lab/TrimPanel.tsx` + `trim-panel.css` + `trim-panel.test.ts`, NEW `lib/lab/trimApply.ts` + test, NEW `lib/lab/trimSession.ts` + test; `lib/sim-protocol.ts` (`TrimRequest` + one result variant), `lib/sim/shard-protocol.ts` (`TrimPlanJob`/`TrimPlanResult` + two union members — **outside the additive list, needed: the job union is what `executeShard` switches over**), `lib/sim/execute.ts` (`runTrimPlan` + one case), `lib/sim/run.ts` (**`runSuggest`'s round loop EXTRACTED verbatim into `drivePooledSearch`** so `runTrim` drives the same ladder — a refactor, not additive; `runTrim` + one case), `lib/useLabSelection.ts` (**`LabTabId` gains `'trim'` — outside the list, one word; lane M will need `'manabase'` on the same line**), `lib/lab-config.ts` (`TRIM_TARGET_SIZE`, `TRIM_DEFAULT_SETTINGS`, `LARGEST_CONSTRUCTED_DECK_SIZE`), `views/LabView.tsx` (tab row, `onApplyCut`, one mount), `about/changelog.ts` (one row), DESIGN §3.174, this row. 🔎 **GATE (HEAD a8831b5+):** `npm run build` green (all packages; web tsc + vite); vitest single-thread over trim.test (26), trimApply (3), trimSession (5), trim-panel (6) + suggest (25), swap-scope (14), lab-config (3), lab-pools (5), changelog guard (83), determinism (20) = **190/190, exit 0**; six sabotages → 17 red, restored → green. 🖥️ **Integrator: preview Lab → Trim** (see the worker report for the click path) — the panel was pinned by static render only; the live round-to-round loop was not driven in a browser by this lane. ⚠️ **SEMANTIC NOTE FOR THE INTEGRATOR:** `applySwap` now interprets `in === SWAP_IN_NOTHING` as a cut (one or more `out` ids joined by `CUT_OUT_SEPARATOR`); every other consumer still sees an opaque string. `runSuggest`'s behaviour is unchanged (its loop moved, byte for byte, into `drivePooledSearch`); `determinism.test.ts` is the guard. | 🚧 PUSHED, not merged |
| fix/one-deck-collection | worker (jb-onelist) | **apps/web**: NEW `lib/decklist/paperDecks.ts` + `paperDecks.test.ts`, NEW `views/one-deck-collection.test.ts`, NEW `scripts/verify-one-deck-collection.mjs`; DELETED `lib/decklist/ownerDecks.ts` + `ownerDecks.test.ts`, `views/owner-decks.css`, `scripts/verify-owner-decks.mjs`; `lib/deck.ts` (`UnresolvedCard`, `Deck.unresolved`, `removeUnresolved`, `unresolvedCopies`, `describeDeckProblems`, two `validateDeck` issues), `lib/storage.ts` (carry `unresolved` through `normalizeDeck`), `lib/useDecks.ts` (seed + reconcile on load, `removeUnresolvedCard`), `lib/config.ts` (one new key), `lib/persistence/budget.ts` (**one new row `seeded-decks`, share 0.002**), `lib/decklist/deckOrigin.ts` (`owner` row+member REMOVED, `mine` moved first), `lib/decklist/deckMenu.ts` (owner group removed), `lib/play/setup.ts` (`owner` `DeckChoice` + `DECK_CHOICE_RULES` row removed), `views/DeckBuilderView.tsx` (`OwnerDecks` region DELETED, row problem line, unresolved deck group), `views/builtin-deck-identity.test.ts` (one fixture field), `components/deck-origin.css`, `styles.css`. **packages/sim**: DELETED `data/owner-decks/acidic-angels.ts`; `data/owner-decks/index.ts` (row removed, `ownerDeckRules` DELETED), `src/index.ts` (export block only), `src/owner-decks.test.ts`. **docs**: DELETED `docs/decks/acidic-angels.txt`; `docs/decks/README.md`, DESIGN §3.157 (+ §3.153 flagged superseded), COORDINATION. ⚠️ **Does NOT touch `packages/cards/**`, `packages/core/**`, `packages/ai/**`, `packages/data-tools/**`, or ANY generated data (`packages/cards/data/`, `packages/data-tools/data/`, `apps/web/src/data/`) — the pool-refresh lane owns those.** ⚠️ **SEMANTIC CONFLICT FOR THE INTEGRATOR:** `DeckOrigin` lost its `owner` member and `DECK_ORIGINS` lost that row; key order IS `<optgroup>` render order and `mine` is now first. Any lane that merged a `DeckOrigin` switch, an `origin === 'owner'` branch, or a `source: 'owner'` `DeckChoice` will fail to type-check — that is the intended signal, not a merge artifact. `packages/sim` no longer exports `ownerDeckRules`. ⚠️ **§3.157 claimed off a contended range** — §3.156 was the highest on `origin/main` `f7fb8a5` at fork; renumber freely, nothing in code refers to it. 🔎 **GATE, derived from the diff** (`apps/web`, `packages/sim`, `docs/decks`) plus the CONSUMERS of what changed (`packages/ai`, `packages/core`, `apps/server` all import `@jonny-boi/sim`), each run separately, unpiped: see the worker report in-message for exit codes and counts. ⚠️ **`apps/web` on `origin/main` `f7fb8a5` is ALREADY RED** — 157 files / 2,151 tests, **2 failed, exit 1**, both in `lib/play/optional-trigger.test.ts` (`mayPlayExiledCard` is a 17th asking primitive with no `OPTIONAL_GATE_SHAPES` row, from the iterative-effects merge). Measured on a clean `origin/main` worktree. **Not mine, not fixed here.** 🖥️ `node apps/web/scripts/verify-one-deck-collection.mjs` **80 checks, exit 0**; the byte-identical script against an `origin/main` build **exits 1, 26 failures** (4 paper regions, 3 paper badges, his decks absent from "Your decks", Acidic Angels 0 steppers). | 🚧 COMMITTED, not pushed |
| feat/scaffold | DESKTOP-90PJPM4 | root configs + all package skeletons | ✅ INTEGRATED |
| feat/core-engine | DESKTOP-90PJPM4 (worker) | packages/core | ✅ INTEGRATED |
| feat/cards-pool | DESKTOP-90PJPM4 (worker) | packages/cards | ✅ INTEGRATED |
| feat/ai-pilots | DESKTOP-90PJPM4 (worker) | packages/ai | ✅ INTEGRATED |
| feat/sim-harness | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| feat/web-foundation | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/engine-v2-triggers | DESKTOP-90PJPM4 (worker) | packages/core | ✅ INTEGRATED |
| feat/cards-v2 | DESKTOP-90PJPM4 (worker) | packages/cards | ✅ INTEGRATED |
| feat/web-lab | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| fix/fidelity-caveat | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| (net-protocol) | DESKTOP-90PJPM4 (integrator) | packages/protocol (new) | ✅ INTEGRATED (committed direct to main) |
| feat/online-server | DESKTOP-90PJPM4 (worker) | apps/server (new) + root cfg | ✅ INTEGRATED |
| feat/online-client | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/match-viewer | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/mcts-ai | DESKTOP-90PJPM4 (worker) | packages/ai (+sim wiring) | ✅ INTEGRATED (selectable, not default) |
| feat/hotseat-play | DESKTOP-90PJPM4 (worker) | apps/web | ✅ INTEGRATED |
| feat/meta-decks | DESKTOP-90PJPM4 (worker) | packages/sim (data) | ✅ INTEGRATED |
| feat/suggestion-engine | DESKTOP-90PJPM4 (worker) | packages/sim | ✅ INTEGRATED |
| feat/data-tools-scryfall | DESKTOP-90PJPM4 (worker) | packages/data-tools | ✅ INTEGRATED |
| feat/deck-import | DESKTOP-90PJPM4 (worker) | packages/cards/src/compile + apps/web import | ✅ INTEGRATED |
| fix/ai-play-quality | DESKTOP-90PJPM4 (worker) | packages/core + packages/ai + sim/cli + apps/web hover | ✅ INTEGRATED |
| fix/rules-audit | DESKTOP-90PJPM4 (worker) | packages/core mana-plan + apps/web play/online | 🚧 PUSHED, not merged |
| feat/activated-abilities | DESKTOP-90PJPM4 (worker) | packages/core + cards/compile + ai/heuristic | ✅ INTEGRATED (via feat/card-mechanics) |
| feat/conditional-taplands | DESKTOP-90PJPM4 (worker) | packages/core card.ts/engine.ts + cards/compile | ✅ INTEGRATED (via feat/card-mechanics) |
| feat/card-mechanics | DESKTOP-90PJPM4 (worker) | packages/cards primitives+compile, core targeting | ✅ INTEGRATED |
| feat/pool-adaptive-wire | worker | apps/web + packages/sim | ✅ INTEGRATED |
| feat/card-index-truth | worker | apps/web/src/data + apps/web/scripts + web card docs | ✅ INTEGRATED |
| perf/mcts-usable | worker | packages/ai | ✅ INTEGRATED (NO-GO: mcts slower AND weaker) |
| feat/attachments | worker | packages/core (attachments+SBA+layers), packages/cards (primitive+compile), packages/ai (heuristic), +1 line in packages/sim/paired-arms-config | 🚧 PUSHED, not merged |
| spike/engine-representation | worker | spikes/engine-representation (new) + 2 narrow eslint.config.js additions | 🚧 PUSHED, not merged — DECISION SPIKE, no product code |
| feat/hybrid-search | worker | packages/ai (new: search-stats/evaluator/hybrid/hybrid-config + heuristic policy seam + bench), DESIGN §3.4a | 🚧 PUSHED, not merged |
| feat/counters-templates | worker | packages/cards compile/rules.ts + primitives.ts, packages/core triggers.ts/statics.ts, apps/web about/mechanics.ts (1 entry), DESIGN §3.11 | 🚧 PUSHED, not merged |
| feat/pilot-relative-verdicts | worker | apps/web ONLY (lib/sim/pilots+history-store+protocols+run/plan/execute, lab panels, LabView/MatchView), DESIGN §3.7a | 🚧 PUSHED, not merged |
| perf/core-hotpath | worker | packages/core (mana-plan.ts + new mana-plan.test.ts + bench/engine-alloc-bench.ts) | 🚧 PUSHED, not merged |
| feat/tree-reuse | worker | packages/ai (new: tree-reuse.ts + tests; hybrid/hybrid-config/search-stats/index/bench), DESIGN §3.4b | 🚧 PUSHED, not merged — stacks on feat/hybrid-search |
| feat/attachment-cards | worker | packages/cards (data + compile/text.ts + build-expansion.ts + 2 tests), packages/data-tools/data, apps/web/src/data (generated), 1 stale comment in apps/web LabView.tsx, DESIGN §3.11 | 🚧 PUSHED, not merged |
| feat/pilot-observation | worker | packages/sim (new observation.ts + test + bench; match.ts, index.ts, package.json) + MINIMAL packages/ai (new observation.ts, reveal-tally.ts + test; additive edits to pilot.ts, index.ts, one comment in tree-reuse.ts), DESIGN §2 + §3.4c | 🚧 PUSHED, not merged |
| feat/tactical-eval | worker | packages/ai (new: tactical.ts + tactical-suite.ts + 2 test files; evaluator/hybrid/hybrid-config/index/tsconfig/bench + 2 existing tests), DESIGN §3.4d | 🚧 PUSHED, not merged — branches off main |
| fix/land-sequencing | worker | packages/ai (new: land-sequencing.ts + test; heuristic/weights/index/bench + tactical-suite.test), DESIGN §3.4e + §3.4a/§3.4d baseline notes | 🚧 PUSHED, not merged — branches off main; **moves the recorded heuristic baselines** |
| feat/optional-payment | DESKTOP-90PJPM4 (integrator) | packages/core (choices/effects/engine/events/mana/clone + new optional-payment.test.ts), packages/cards (choice-primitives/primitives/effect-helpers/compile rules+text+compile + new test), packages/ai (choices/effect-value/heuristic/weights + tests), packages/sim (2 classification lines), apps/web (choice-view + ChoicePrompt + tests), DESIGN §3.11 | ✅ MERGED + DEPLOYED |
| feat/trigger-targets | DESKTOP-90PJPM4 (integrator) | packages/core (triggers/state/choices/engine/events/clone + new trigger-targets.test.ts), packages/cards (compile types/compile/rules + new test), packages/ai (choices/effect-value/weights + tests), packages/sim (2 classification lines), apps/web (choice-view + ChoicePrompt + tests), DESIGN §3.11 | ✅ MERGED + DEPLOYED |
| feat/token-doublers | DESKTOP-90PJPM4 (integrator) | packages/core (replacement/internal-replacement/effects/events), packages/cards (primitives + compile rules + replacement-effects.test reversed + new token-doublers.test.ts), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/pilot-perf-2 | DESKTOP-90PJPM4 (integrator) | packages/core (engine.ts castCostReducersFor threaded through the offer pass), packages/ai (heuristic.ts sorcery-window early-out) | ✅ MERGED + DEPLOYED |
| feat/pilot-perf-1 | DESKTOP-90PJPM4 (integrator) | packages/core (engine.ts hoisted continuous index in the ability-offer loop) | ✅ MERGED + DEPLOYED |
| feat/granted-abilities | DESKTOP-90PJPM4 (integrator) | packages/core (statics/continuous/stats effectiveActivated + PermanentModification.activated, engine both ability read sites, conformance witness), packages/cards (compile types/compile compileQuotedAbility + newAssembly + mergeModifications, rules 2 grant rules + groupStaticAffects, NEW granted-ability.test.ts, NEW scripts/fetch-full-corpus.mjs + keyword-gap-report.mjs) | ✅ MERGED + DEPLOYED |
| feat/near-miss-4 | DESKTOP-90PJPM4 (integrator) | packages/core (triggers.ts lifeLoss + triggeringAmount + TRIGGER_EVENT_SOURCES row, state/clone/choices/effects/engine amount channel, card.ts derived name, NEW that-much.test.ts), packages/cards (effect-helpers intParam reader, compile rules trigger-life-loss + TRIGGERING_AMOUNT_BODIES table), UNSUPPORTED-BACKLOG.md | ✅ MERGED + DEPLOYED |
| feat/graveyard-hate | DESKTOP-90PJPM4 (integrator) | packages/core (card.ts ActivationCost.sacrificeAnother/ExcludesSelf/Count, actions.ts costInstanceIds, engine.ts sacrificeCostCandidates + gate/charge/offer, instance-ids ledger, NEW activation-sacrifice-cost.test.ts), packages/cards (primitives exileGraveyard, compile rules exile-graveyard + COST_NOUNS shared with parseActivationCost, activated.test probe flip, target-noun-table.test additions), packages/ai (effect-value price), packages/sim (paired-arms +1), UNSUPPORTED-BACKLOG.md | ✅ MERGED + DEPLOYED |
| feat/near-miss-3 | DESKTOP-90PJPM4 (integrator) | packages/cards (compile.ts: compileConjunction shared by the spell line + nested clause compilers, NEW compile/conjunction-sharing.test.ts), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/near-miss-2 | DESKTOP-90PJPM4 (integrator) | packages/core (card.ts ManaAbilityCost tapAnother/sacrificeAnother/noTap, actions.ts costInstanceId, engine.ts offer+charge+noTap, instance-ids ledger, NEW mana-cost-another.test.ts), packages/cards (compile rules MANA_COST_NOUNS table + rule, mana-templates probe flip), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/near-miss | DESKTOP-90PJPM4 (integrator) | packages/core (targeting: 5 new restrictions across all 6 sites incl. BOTH enumeration arms), packages/cards (compile rules: shared TARGET_NOUN/COUNTER_NOUN tables read by destroy/exile/counter, NEW compile/target-noun-table.test.ts, NEW scripts/near-miss-report.mjs), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/pact-upkeep | DESKTOP-90PJPM4 (integrator) | packages/cards (choice-primitives payManaOrElse + scheduleDelayedPayment, compile rules pact-upkeep-bill, NEW pact-upkeep.test.ts), packages/ai (effect-value prices), packages/sim (paired-arms +2), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/dead-rule-sweep | DESKTOP-90PJPM4 (integrator) | packages/cards (compile.ts inner matchedRules, compile/rules.ts stale description, NEW compile/rule-coverage.test.ts, NEW scripts/dead-rule-sweep.mjs) | ✅ MERGED + DEPLOYED |
| feat/gatecreeper | DESKTOP-90PJPM4 (integrator) | packages/cards (compile rules: optional article in the two-branch tutor; NEW gatecreeper-search.test.ts), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/block-selectors | DESKTOP-90PJPM4 (integrator) | packages/core (statics.ts maxEffectivePower(+OrToughness), internal/continuous.ts deferred settled-P/T pass, NEW effective-pt-statics.test.ts), packages/cards (compile rules +1 static rule, indestructible-and-blocking.test probe flip), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/modal-memory | DESKTOP-90PJPM4 (integrator) | packages/core (state.ts modesChosenThisTurn, card.ts ModalSpec.notChosenThisTurn, clone.ts, engine.ts menu filter + record + beginTurn reset, modal-trigger.test), packages/cards (text.ts header phrase, rules.ts modal-choose memory group, modal-trigger-compile.test), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/modal-trigger-targets | DESKTOP-90PJPM4 (integrator) | packages/core (engine.ts choosable-mode filter + targeted-mode aim handoff, modal-trigger.test additions), packages/cards (compile.ts choose-one targeted-mode relaxation, modal-trigger-compile.test), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/modal-triggers | DESKTOP-90PJPM4 (integrator) | packages/core (triggers.ts TriggeredAbility.modal, state.ts awaitingModes, clone.ts, engine.ts askTriggerModes/recordTriggerModes + answer branch, events.ts triggerModesChosen, instance-ids, NEW modal-trigger.test.ts), packages/cards (text.ts trigger-line modal fold + any-number, compile.ts modal body handoff, rules.ts guards+spreads + counters-then-grant rule, types.ts, NEW modal-trigger-compile.test.ts), packages/ai (modeEffectsFor reads awaitingModes), packages/sim (observation/soak-config modal-trigger witness), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/proliferate | DESKTOP-90PJPM4 (integrator) | packages/cards (primitives proliferate + addCountersOfKind refactor, compile rule + keyword backing + hint reword, NEW proliferate.test.ts), packages/ai (effect-value price), packages/sim (paired-arms +1), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/per-creature-combat-damage | DESKTOP-90PJPM4 (integrator) | packages/core (triggers.ts creatureCombatDamageToPlayer, group-combat-damage.test additions), packages/cards (compile rules +1, predefined-tokens.test +1), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/upkeep-bodies | DESKTOP-90PJPM4 (integrator) | packages/cards (choice-primitives battlefield arm, compile rules reanimate wording, text.ts thirteen/twenty, step-trigger probe flip, may-cost-effects.test additions), packages/ai (effect-value tweak), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/graveyard-target | DESKTOP-90PJPM4 (integrator) | packages/core (targeting creatureCardInYourGraveyard, 6 sites), packages/cards (choice-primitives moveTargetFromGraveyard, compile rule, may-cost-effects.test additions), packages/ai (effect-value price), packages/sim (paired-arms +1), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/may-cost-effects | DESKTOP-90PJPM4 (integrator) | packages/cards (primitives mayCostEffects + payability gate, compile rules may-cost-then-effect, NEW may-cost-effects.test.ts), packages/ai (effect-value price), packages/sim (paired-arms +1), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/group-combat-damage | DESKTOP-90PJPM4 (integrator) | packages/core (triggers.ts groupCombatDamageToPlayer + subject-for-damageDealt, triggers-runtime batch dedup, NEW group-combat-damage.test.ts), packages/cards (compile rules +1 trigger rule, predefined-tokens.test +1), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/etb-may-targets | DESKTOP-90PJPM4 (integrator) | packages/core (targeting artifactOrEnchantment, 6 sites), packages/cards (compile rules destroy alternation widened, NEW naturalize.test.ts), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/win-the-game | DESKTOP-90PJPM4 (integrator) | packages/core (index.ts export loseGame/winGame), packages/cards (primitives winTheGame/loseTheGame, compile rules win/lose/investigate + treasure/clue/food subtypes + PRIMITIVE_BACKED_KEYWORDS, NEW win-the-game.test.ts, 2 probe swaps Clue→Contraption), packages/ai (effect-value prices), packages/sim (paired-arms +2), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/predefined-tokens | DESKTOP-90PJPM4 (integrator) | packages/core (card.ts ManaAbilityCost.sacrificeSelf + engine.ts payment, NEW treasure-mana.test.ts), packages/cards (NEW predefined-tokens.ts + test, primitives createPredefinedToken, compile rules create-predefined-token, equipped-triggers probe flip), packages/ai (effect-value price + weights.bankedEffectValueShare), packages/sim (paired-arms +1), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/endstep-blink | DESKTOP-90PJPM4 (integrator) | packages/cards (blink-primitives ownerControl, compile rules blink pattern generalized, compile.ts+types.ts upToTargets->targetCount lift, NEW blink-tails.test.ts), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/copy-tails | DESKTOP-90PJPM4 (integrator) | packages/core (targeting tokenYouControl + targeting-completeness zoo), packages/cards (primitives substituteIf, copy-primitives for-each, compile rules 2 new rules + selector + hint reword, copy-templates.test additions), packages/ai (effect-value substituteIf price), packages/sim (paired-arms-config +1 classification), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/delayed-triggers-v2 | DESKTOP-90PJPM4 (integrator) | packages/core (new delayed.ts + effects/events/state/targeting/serialize/clone/index/instance-ids), packages/cards (primitives/copy-primitives/compile + new delayed-and-token-count.test.ts), packages/ai (heuristic/combat-forecast/effect-value + parity ledger), packages/sim (soak/soak-config/observation/paired-arms), apps/web (about mechanics + play/replay format), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/modal-one-or-more | DESKTOP-90PJPM4 (integrator) | packages/core (targeting + 1 test fixture), packages/cards (compile rules/text + new modal-one-or-more.test.ts), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/cost-reduction | DESKTOP-90PJPM4 (integrator) | packages/core (card/engine/index + new cost-reduction.test.ts), packages/cards (compile rules/compile/types), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/karoo-lands | DESKTOP-90PJPM4 (integrator) | packages/core (card/engine), packages/cards (choice-primitives + compile rules/compile/types + new karoo-lands.test.ts), packages/sim (1 classification line), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/copy-templates | DESKTOP-90PJPM4 (integrator) | packages/core (targeting/state/engine/clone/intervening), packages/cards (compile rules+compile+types + new copy-templates.test.ts), UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED + DEPLOYED |
| feat/shocklands | worker | packages/core (card/choices/effects/engine/index + new shockland.test.ts), packages/cards (choice-primitives/effect-helpers/compile rules+text+types+compile + activated.test + new shockland.test.ts), packages/ai (choices.ts), apps/web (choice-view + ChoicePrompt + choice-session.test), DESIGN §3.11, UNSUPPORTED-BACKLOG.md (regenerated) | ✅ MERGED |
| feat/about-mechanics | worker | apps/web (new views/AboutView.tsx + views/about.css + lib/about/mechanics.ts+test; App.tsx nav), packages/cards (export-only edits: compile/compile.ts, compile/index.ts, index.ts) | ✅ MERGED |
| feat/source-aware-targeting | worker | packages/core (protection.ts NEW + card/targeting/attachments/events/engine/index + internal stats/continuous/combat + protection.test.ts NEW), packages/cards (primitives + choice-primitives `wardCounterUnlessPaid` + compile rules/compile + ward-protection.test.ts NEW + 2 reworded tests), packages/sim (2 classification lines), packages/ai (heuristic source threading), apps/web (2 formatter cases + about/mechanics.ts entries), DESIGN §3.11 | 🚧 PUSHED, not merged |
| fix/online-playability | DESKTOP-90PJPM4 | apps/web/src/lib/online (auto-pass, why-disabled, drag-to-play, useDragToPlay, online-config + tests), components/online/OnlineBoard.tsx, components/play/PlayCard.tsx, styles.css (drag/drop-zone rules, appended), apps/server land-playability.test.ts, COORDINATION.md | ✅ MERGED |
| feat/double-faced-cards | worker | packages/core (card/state/events/engine guards + NEW transform.ts, internal/zones+clone+triggers-runtime, NEW transform.test.ts), packages/cards (choice-primitives transformRevealTop, effect-helpers face-revert, compile types/compile/rules/index, data/pool.ts Delver, src/index.ts STUBBED_MECHANICS, NEW transform-play.test.ts), packages/sim (paired-arms-config +1 classification; fidelity copy in config/cli/swap), apps/web (lib/cards.ts back-face records + NEW cards.test.ts, lib/about/mechanics.ts + test), DESIGN §3.13 | 🚧 PUSHED, not merged |
| (devoid) | DESKTOP-90PJPM4 (integrator) | packages/cards compile (builder row + colorless contribution), NEW scripts/keyword-cards.mjs, DESIGN §3.104 | ✅ MERGED (committed direct to main) |
| feat/poison-family | DESKTOP-90PJPM4 (worker, wave 1) | infect / wither / toxic / poison counters — packages/core (player poison + SBA + damage-as-counters replacement), packages/cards compile rows, packages/ai valuation | ✅ MERGED (d2bcc18; +57 complete) |
| feat/upkeep-cost-family | DESKTOP-90PJPM4 (worker, wave 1) | echo / cumulative upkeep / suspend / vanishing / fading + "sacrifice unless you pay" upkeep template — packages/core (time/age counters, upkeep pay-or-sacrifice choice, suspend exile-with-counters + free cast), packages/cards compile rows, packages/ai choice | ✅ MERGED (9021d25; +104) |
| feat/combat-keyword-family | DESKTOP-90PJPM4 (worker, wave 1) | exalted / rampage / flanking / landwalk / shadow / myriad / split second / provoke + the combat template gaps ("attacks each combat if able", "can block only creatures with flying", "can't be blocked by more than one", "can block an additional creature", attack/block self-pump triggers) — packages/core combat + KeywordFlags, packages/cards compile rows, packages/ai canBlockByEvasion mirror | ✅ MERGED (c2bb4f1; +267) |
| feat/pilot-100x | DESKTOP-90PJPM4 (worker, wave 1) | packages/ai ONLY (+ bench scripts under packages/sim/bench) — heuristic strength (scoreAttackSet defence model) and decision-function speed, every change behind a HeuristicFeatures flag and judged by feature-ab.mjs two-seed protocol + pilot-decide-bench.mjs | ✅ MERGED (3c170ee; gang blocks ON, fast pass widened, 1.2–1.4x games/sec) |
| (keyword anomalies) | DESKTOP-90PJPM4 (integrator) | protection from types/subtypes/monocolored/each color, semicolon keyword lines, affinity subtypes — DESIGN §3.109 | ✅ MERGED (e724815; +25) |
| feat/counter-keyword-family | DESKTOP-90PJPM4 (worker, wave 2) | modular / undying / evolve / renown / bloodthirst / fabricate / unleash / backup / mentor / amass / riot / outlast / devour / bolster / reinforce / afterlife / dethrone / explore + counter templates — §3.110 | ✅ MERGED (42789a4; +190) |
| feat/graveyard-cast-family | DESKTOP-90PJPM4 (worker, wave 2) | unearth / scavenge / retrace / embalm / eternalize / encore / escape / jump-start / non-mana flashback costs + graveyard-return templates — §3.111 | ✅ MERGED (0069330; +146) |
| feat/cast-alternative-family | DESKTOP-90PJPM4 (worker, wave 2) | evoke / dash / channel / foretell / prototype / blitz / plot / warp / entwine / replicate / conspire / surge / casualty / assist / splice / transmute / cipher / bloodrush / ninjutsu — §3.112 | ✅ MERGED (117ea9d; +121 on the merged tree) |
| feat/spell-count-family | DESKTOP-90PJPM4 (worker, wave 2) | storm / cascade / ripple / learn / investigate / double + mill/scry/surveil shapes + loot templates — §3.113 | ✅ MERGED (acbd9f0; +145) |
| fix/reports-2026-09-01 | DESKTOP-90PJPM4 (worker) | the seventeen in-game bug reports of 2026-09-01/02 (Downloads/bugreport_2026090*.zip): rules (Swiftspear/Gatecreeper, blocks with no attackers, Thragtusk life, Angel of Serenity, Goblin Guide reveal, Conjurer's Closet order), the priority/stack-response UX with auto-pass stops, display fixes (blank cards, crunched battlefield, attack indicators, hand hover, stuck drag ghost, mulligan wording, Lab screenshot timeout) — §3.119 | ✅ MERGED (a127375; all 16 reports) |
| (living weapon) | DESKTOP-90PJPM4 (integrator) | living weapon + the gang-block requirement-size fix — packages/cards primitives/rules, packages/ai heuristic, DESIGN §3.121 | ✅ MERGED (179a89d; +10, pool 5,633) |
| (soulshift) | DESKTOP-90PJPM4 (integrator) | soulshift — one TRIGGER_RULES row + a sweep guard, DESIGN §3.122 | ✅ MERGED (b276cc7; +18, pool 5,651) |
| fix/pool-6257-soak | DESKTOP-90PJPM4 (worker) | the 6,257-card pool regeneration + the two offers the engine refused (transmute sorcery timing, a land offered as a cast) + two INERT soak witnesses — DESIGN §3.123 | ✅ MERGED (landed with the §3.123 sweep) |
| fix/pool-refresh-3147 | DESKTOP-90PJPM4 (integrator) | regenerate the shipped pool — it has been 5,651 since 2026-09-03 while the compiler gained §3.124–§3.146; measure, regenerate, gate (suite + soak), report the bundle cost | ⛔ SUPERSEDED by chore/pool-regeneration (2026-09-19): last moved 2026-09-11, 328 commits behind main, its 5,651→6,323 regeneration overtaken by main's 6,944. Its four soak fixes: two already on main by other routes; the graveyard-cast witness + the turn-0 mill leak remain, see §3.160. |
| chore/pool-regeneration | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | the three generator commands from main 5a010c7, offline: `expanded-pool.ts`, `expansion-report.json`, `starter-cards.json`, both card indexes — 6,944 → 7,042 (+98 compiled), all four artefacts agree; soak 25/25 + loop-runaway 6/6 locally; DESIGN §3.160. ⚠️ Touches ONLY generated data + docs; no source. | ✅ MERGED (#64) |
| feat/jace-ultimate-cross-seat-cast | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **packages/core**: `card-grants.ts` (`CardGrant.castBy`, `CastPermission.by`), `engine.ts` (offer loops walk the grant list across both exiles; cast/play refuse the wrong seat by name; `card.controller = action.player` at cast — CR 112.2), NEW `cross-seat-cast.test.ts`. **packages/cards**: `choice-primitives.ts` (`searchLibrary` rows `who:'each'`, `chooser:'controller'`, destination `exile`, `grantCast:'free'`), `compile/rules.ts` (rule `search-each-library-exile-cast-free`, "nonland" noun), NEW `jace-ultimate-play.test.ts`, `walker-residues.test.ts` + `loyalty-emblem-family.test.ts` pins flipped, `core/split-cards.test.ts` shape (+`by`). Generated data regenerated (7,010 → 7,011). DESIGN §3.161. | 🚧 PR #65 OPEN — CI |
| feat/thunes-life-skyclave-tyvar | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **His six cards for Thune's Life (§3.162).** **packages/core**: `card.ts` (`ActivationCost.removeCounters`, `ActivatedAbility.targetsExcludeSelf`), `engine.ts` (payability + payment of the counter cost; "another" on the activated offer/apply), `statics.ts` (`hasCounterMin`), `targeting.ts` (members `nonlandPermanentAnOpponentControls`, `creatureOrEnchantmentYouControl` in all five homes; `TargetBound.nontoken`; `illegalTargetReasonForEffects` exclusion), NEW `activation-remove-counters-cost.test.ts`, NEW `targeting-scoped-nouns-and-nontoken.test.ts`. **packages/cards**: `compile/rules.ts` (`KEYWORD_LIST_TOKEN`/`keywordFlags`, `COUNTER_KIND_TOKEN`/`parseRemoveCountersCost`, `COUNTER_TARGET_NOUNS`, rules `static-self-counter-threshold-keywords`, `token-for-exiled-by-this`, "up to one" on the linked ETB, "another" on `grant-keyword-until-eot`, noun rows; bound pre-pass: nontoken, multi-bound, apostrophe, `applyTargetBoundToContribution`), `compile/compile.ts` (cost row, `targetsExcludeSelf` lift), `effect-helpers.ts` (`restrictionParam` returns the whole spec — §3.150 correction), `exile-until-leaves.ts` (`tokenForExiledByThis`), `primitives.ts` (`tokenDefFromParams` exported), `copy-primitives.ts` (one line), NEW `thunes-life-additions.test.ts`, NEW `bounded-target-resolution.test.ts`, `compile/target-bounds.test.ts`. **packages/ai**: NEW `activation-cost.ts` + test, `heuristic.ts` (net-of-cost scoring at two sites; exclusion on the funded aim). **packages/sim**: NEW `data/owner-decks/revisions.ts`, `data/owner-decks/index.ts` (`revisions`, `currentOwnerDeck`), `thunes-life.ts` (`THUNES_LIFE_REVISIONS`), `src/index.ts` (exports), `owner-decks.test.ts` (revision grammar + add-only pin). **apps/web**: `lib/deck.ts` (`AppliedRevision`, `Deck.revisions`, `dismissRevisionNote`), `lib/storage.ts` (carry it), `lib/decklist/paperDecks.ts` (`planRevisions`, `applyRevisionToDeck`, `revisionLedgerId`, `deck-absent`), `lib/useDecks.ts` (the pass + `dismissRevisionNote`), `views/DeckBuilderView.tsx` (the note panel), `styles.css`, two view-test fixtures, `paperDecks.test.ts`. **docs**: `docs/decks/thunes-life.txt` (the `// revision` block), `docs/decks/README.md`, DESIGN §3.162. Generated data regenerated: 7,010 → 7,102 (+92), index 7,134/7,134. ⚠️ Heliod's devotion type layer (§3.163) and Selvala's parley (§3.164) are NOT in this lane; both cards ride the deck's wish-list. | 🚧 COMMITTING |
| feat/lab-card-picker | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **The Lab's A/B pickers (§3.165) — web only.** **apps/web**: NEW `lib/lab/cardPicker.ts` (+test; ranking, cap, bounds over the browser's `queryCards`), NEW `lib/lab/swapScopeOptions.ts` (+test; the copies menu derived from the cut line, `reconcileScope`), NEW `components/lab/CardPicker.tsx` + `card-picker.css` (the ARIA combobox), `components/lab/SwapPanel.tsx` (two pickers, the trimmed menu, the applied button), `views/lab-apply.css` (the done style), NEW `components/lab/swap-panel-pickers.test.ts` (static render of the real panel). DESIGN §3.165. ⚠️ No engine, cards, ai or sim files; no generated data. Based on main 1fdb3b4 — DESIGN §3.162–§3.164 land from the stacked lanes first, so the roadmap insert will need a trivial both-added merge. | ✅ MERGED (#69) |
| feat/heliod-devotion-type-layer | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **Heliod, Sun-Crowned and devotion (§3.163) — stacked on feat/thunes-life-skyclave-tyvar.** **packages/core**: NEW `devotion.ts` (`devotionTo` CR 700.5, `nonCreatureFormOf`/`creatureFormOf` memoised definition swap, `settleDevotionForms`), NEW `devotion.test.ts`, `card.ts` (`creatureUnlessDevotion`, `creatureForm`, five devotion `DerivedCountName` rows), `derived.ts` (the rows), `internal/zones.ts` (reset restores the base form FIRST; leave funnel re-settles), `internal/sba.ts` (settle at the head; `alwaysLook`), `upkeep-costs.ts` (`markBattlefieldEntry`/`markControlChange` settle), `engine.ts` (settle before the resolution `zoneChange` emit), `index.ts` (exports). **packages/cards**: `compile/rules.ts` (rule `god-creature-unless-devotion`; `NAMED_DERIVED_COUNTS` + `WHERE_X_ARITHMETIC` devotion rows), `compile/types.ts` + `compile/compile.ts` (the contribution), `effect-helpers.ts` (`movePermanentTo` settles), `primitives.ts` (`addCounters` +1/+1 on ANY permanent — CR 122.1), NEW `heliod-play.test.ts`. **apps/web**: `lib/play/optional-trigger.ts` (two field rows). **docs**: `docs/decks/thunes-life.txt`, `docs/decks/README.md`, DESIGN §3.163. Generated data regenerated on the merged tree: 7,103 → 7,115 (+12), index 7,147/7,147, `--check` clean. ⚠️ Selvala's parley (§3.164) is NOT in this lane. | 🚧 PR after #66 |
| feat/whole-corpus-in-app | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **Every Scryfall card in the app, two tiers (§3.167).** **packages/data-tools**: NEW `corpus-index.ts` (+test; `SLIM_CARD_KEYS`, `buildCorpusIndex`, `serializeCorpusIndex`), NEW `scryfall-image.ts` (URL derivation from the printing id), `pipeline.ts` (a corpus run also writes `data/corpus-index.json` — 25,170 cards the pool does not hold, on the merged tree), `constants.ts`/`paths.ts` (`CORPUS_INDEX_FILENAME`, `corpusIndexPath`), `pure.ts` + `index.ts` (exports), `cli.ts` (report line); NEW generated `data/corpus-index.json`. **apps/web**: NEW `lib/cards/corpus.ts` (+test; the fetched, expanded, subscribable tier), NEW `lib/cards/playable.ts` (cheap predicate + compile-on-demand reasons), `lib/cards.ts` (lookups + `allAvailableCards` memo + derived art), `lib/filter.ts` (`playable` filter), `lib/decklist/deckHealth.ts` (the corpus row), `components/CardToolbar.tsx` (All/Playable + count), `CardTile.tsx`/`CardGrid.tsx` (the badge), `CardDetail.tsx` (the sentence), `views/CardsView.tsx`, `views/DeckBuilderView.tsx`, `views/LabView.tsx` (playable-only add list), `App.tsx`, `styles.css`, `vite.config.ts` (runtime-cached asset, not precached), `scripts/build-card-index.mjs` (drops derivable image URLs), `data/card-index.json` regenerated (10.8 → 7.7 MB), NEW `components/unplayable-marking.test.ts`, `data/card-index.test.ts`, `lib/filter.test.ts`. DESIGN §3.167. ⚠️ Adds a 12 MB generated JSON to the repo (2.65 MB gz on the wire). | ✅ MERGED (#71) |
| feat/about-changelog | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **The in-app changelog of mechanics (§3.166) — web only, stacked on feat/heliod-devotion-type-layer for the pool it names.** **apps/web**: NEW `lib/about/changelog.ts` (+test — reads DESIGN.md: every row is a ✅ section, every ✅ section ≥ §3.155 has a row, every named card is in the pool, mechanic witnesses resolve), NEW `components/about/MechanicsChangelog.tsx` (+static-render test), `views/AboutView.tsx` (mounted under the summary strip), `views/about.css`. DESIGN §3.166. ⚠️ Merging main after §3.164/§3.165 land WILL fail the sync guard until their rows are added — that is the guard working; add the two rows in the merge commit. | 🚧 PR after #68/#69 |
| feat/derived-mana-amount | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **A mana ability whose AMOUNT the board decides, and parley (§3.164) — stacked on feat/heliod-devotion-type-layer.** **packages/core**: NEW `mana-amount.ts` (+test; `ManaAmountSource`, `manaAmountOf`, `scaleProduction`, `splitMatchesAmount`), `card.ts` (`ManaAbility.amount`/`anyCombination`, `ManaAbilityRider.parley`), `actions.ts` (`TapForManaAction.split`), `engine.ts` (`applyTapForMana`: scaling, split validation, the parley reveal/life/draws), `mana-plan.ts` (scaled planning; parley skipped), `index.ts`. **packages/cards**: `compile/rules.ts` (rules `mana-ability-derived-amount`, `mana-ability-parley`; `manaAmountFromPhrase`; singular `FILTERED_EACH_TO_PLURAL` spellings), NEW `derived-mana-play.test.ts`, `expanded-pool.test.ts` (the mana-ceiling guard reads `PRINTED_DERIVED_AMOUNT`). **packages/ai**: `heuristic.ts` (the parley offer). **apps/web**: `lib/play/mana-tap.ts` (scaled labels, Parley), `lib/play/keyword-glossary.ts` (Parley row). **docs**: `docs/decks/*.txt`, `docs/decks/README.md`, DESIGN §3.164. Generated data regenerated on the merged tree: 7,115 → 7,136 (+21), index 7,168/7,168, `--check` clean. **Both of his decks are now fully supported.** | 🚧 PR after #67 |
| feat/static-conditions | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"As long as …" — when a static is on (§3.169): one pre-pass, one closed table; +123 cards.** **packages/core**: NEW `static-conditions.ts` (+test; `StaticCondition`, `StaticCountSource`, `staticConditionHolds`), `statics.ts` (`StaticAbility.activeWhile`), `internal/continuous.ts` (`staticIsLive` — ONE liveness predicate at the bulk index, the per-permanent aggregate and the emblem fold), `card.ts` + `derived.ts` (`cardTypesInYourGraveyard`), `index.ts`. **packages/cards**: `compile/rules.ts` (`STATIC_CONDITION_SHAPES`, `stripStaticCondition`, `applyStaticCondition`, rule `static-self-modification`, the delirium count row), `compile/compile.ts` (the pre-pass in `applyRules`, STATIC rules only), NEW `compile/static-conditions.test.ts`. **apps/web**: `lib/play/keyword-glossary.ts` (Threshold, Delirium, Fateful hour). Generated data regenerated: 7,136 → 7,259 (+123), index 7,291/7,291. DESIGN §3.169. | 🚧 PR |
| feat/enters-attached | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"When this Equipment enters, attach it to target creature you control" (§3.170) — one effect-rule row on the Equip path; +16 cards.** **packages/cards**: `compile/rules.ts` (rule `attach-self-to-target-creature-you-control`), NEW `enters-attached.test.ts` (Maul of the Skyclaves, played). **packages/sim**: `soak-config.ts` (`trigger-copy` gets the sequenced overtime lane — INERT on the larger pool, the §3.162 class). Generated data regenerated: 7,290 → 7,306 (+16), index 7,338/7,338. DESIGN §3.170. | 🚧 PR |
| feat/self-keyword-grant | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"~ gains KEYWORD until end of turn" / "~ gets +N/+N and gains KEYWORD until end of turn" as an activated or triggered body, and HYBRID mana in an activation cost (§3.171) — +190 cards.** **packages/cards**: `compile/rules.ts` (rules `self-grant-keyword-until-eot`, `self-pump-and-grant-until-eot`), `compile/compile.ts` (`parseActivationMana` — the cast path's hybrid component table, Phyrexian and snow still refused), NEW `compile/self-keyword-grant.test.ts` (10), NEW `self-keyword-grant.test.ts` (2, played: Unyielding Krumar, Stream Hopper). Generated data regenerated: 7,306 → 7,496 (+190, nothing left), index 7,528/7,528. DESIGN §3.171. | 🚧 PR |
| feat/discard-cost | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"Discard a card:" as an activation cost (§3.172) — `ActivationCost.discard`, one card named on the action, paid through the one discard funnel; +103 cards (7,496 → 7,599, nothing left; index 7,631/7,631).** **packages/core**: `card.ts` (the field), `engine.ts` (`discardCostCandidates`; the gate, the offer, the apply path; graveyard abilities refuse it), NEW `activation-discard-cost.test.ts` (6). **packages/cards**: `compile/rules.ts` (`DISCARD_COST_NOUNS`, shared with `COST_NOUNS`), `compile/compile.ts` (`DISCARD_ONE` in `parseActivationCost`; sacrifice+discard refused), NEW `discard-cost.test.ts` (5, Patrol Hound played). **packages/ai**: `activation-cost.ts` (the payer priced at `cardValue`), `heuristic.ts` (payer handed through), `mana-exchange.ts`, NEW `discard-cost-pilot.test.ts` (4). **packages/sim**: `soak-config.ts` + `soak.ts` (witness `discard-cost`), `observation.test.ts` (boundary row). DESIGN §3.172. | 🚧 PR |
| feat/six-rows | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **Six one-row families from the one-clause ranking (§3.173): mass modification on the other board / every board, "target attacking or blocking creature", the "during your turn" static condition, "target creature can't block this turn", "return ~ to its owner's hand", two enters-tapped conditions; +181 cards (7,599 → 7,780, nothing left; index 7,812/7,812).** **packages/core**: `targeting.ts` (`attackingOrBlockingCreature`), `combat-removal.ts` (`blockingCreatureIds`), `static-conditions.ts` (`yourTurn`), `card.ts` (`anyPlayerLifeAtMost`, `minOpponents`; `EntersTappedContext.lifeTotals/opponentCount`), `engine.ts` (`entersTappedFacts`), NEW `six-rows-core.test.ts` (5). **packages/cards**: `compile/rules.ts` (rules `mass-modify-scoped-until-eot`, `grant-cant-block-until-eot`, `bounce-self`, `enters-tapped-unless-a-player-life-at-most`, `enters-tapped-unless-min-opponents`; the damage target row; the your-turn shapes), `primitives.ts` (scope `all`), `choice-primitives.ts` (`bounceSelf`), NEW `six-rows.test.ts` (11). **packages/ai**: `effect-value.ts` (`bounceSelf` priced). DESIGN §3.173. | 🚧 PR |
| feat/lab-manabase | worker (jb-manabase, lane M of the 2026-09-19 Lab wave) | **The Lab experiments with manabases (§3.175): land-only variants of the hero (count ±k, colour mix ±k, dual playsets from the pool, one per functional signature), evaluated with the paired runner and reported by win rate AND measured reliability (missed land drops turns 2–4, colour screw turn 3+, lands at the start of turn 4; mulligans NOT MEASURED — the sim never mulligans), the recommendation rule printed, Apply through the existing apply path.** **packages/sim** NEW `manabase.ts`, `manabase-config.ts`, `manabase-reliability.ts`, `manabase-run.ts` (+2 test files); ADDITIVE `index.ts` (export block), `match.ts` (ONE optional seam `MatchOptions.onState`, one branch per decision, nothing when unset), `paired-arms.ts` (ONE optional seam `PairedArmsOptions.watchGames` + `observed` on `PairedBaseRecord`/`PairedSlice`/`SwapArm`, all optional; `openVariantArm`/`playVariantSlice` for a caller-built in-place variant deck; `summarize` reads `copiesMoved` fixed at open — same value as before). **apps/web** NEW `components/lab/ManabasePanel.tsx` + `manabase-panel.css` + `manabase-panel.test.ts`, `lib/lab/manabaseApply.ts` + test; ADDITIVE `lib/sim-protocol.ts` (kind `manabase` + payload), `lib/sim/shard-protocol.ts` (THREE appended kinds `manabase-plan`/`manabase-base-slot-shard`/`manabase-variant-slice-shard`), `lib/sim/execute.ts` (`suggestionRunner` gained an optional NAMED watch param in its cache key; three executors; three switch cases), `lib/sim/plan.ts` (two appended planners), `lib/sim/merge.ts` (`mergeVariantSlices` parameter WIDENED to `Pick<…,'candidateKey'|'paired'>`), `lib/sim/run.ts` (`runManabase` + one switch case), `lib/useLabSelection.ts` (`LabTabId` + `'manabase'`), `lib/lab-config.ts` (`MANABASE_GAMES`, `MANABASE_SWEEP_RADIUS`), `views/LabView.tsx` (one tab, one mount, `onApplyManabase`), `lib/about/changelog.ts` (one row), DESIGN §3.175. ⚠️ **For lane T (trim):** `useLabSelection.ts`'s `LabTabId` and `LabView.tsx`'s `LAB_TABS`/mount block are the two places both lanes add a line — merge both, keep both. The paired runner's `openVariantArm`/`playVariantSlice` (a caller-built deck, refused unless it is the base deck's length) is the seam a removal arm needs; a 59-card removal is NOT the base rewritten in place and will be refused — see §3.175 for why. `runSuggest`/`runManabase` are the same round loop twice; unify after the wave, not during it. | 🚧 PR |
| feat/activate-once-each-turn | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"Activate only once each turn" (§3.168) — picked from the one-clause measurement (77 cards named it; +31 compiled).** **packages/core**: `card.ts` (`ActivationRestriction` gains `onceEachTurn`), `state.ts` (`CardInstance.onceEachTurnActivated`, the loyalty-turn design), `engine.ts` (`unpayableActivationReason` takes the ability index; the apply path writes the turn), `internal/clone.ts`, `internal/zones.ts` (forgotten on a zone change), NEW `activation-once-each-turn.test.ts`. **packages/cards**: `compile/compile.ts` (`ACTIVATE_ONLY_ONCE_EACH_TURN` tail), `named-counters.test.ts` (+2). Generated data regenerated: 7,136 → 7,167 (+31), index 7,199/7,199. DESIGN §3.168. | 🚧 PR |
| feat/feedback-2026-09 | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **The gathered feedback (§3.176): 37 human bug reports (2026-08-19 → 09-18) triaged against the live build; five fixed here, the rest cited to the section that shipped them or marked not reproducible with the evidence.** **apps/web**: `lib/bugreport/capture-policy.ts` + `capture.ts` (table parts are prune-exempt — 20260918_215728), `components/lab/SuggestPanel.tsx` + `SwapPanel.tsx` (CardHover on result names), `components/play/CardFace.tsx` (`compact` size; the full face’s text box spans the printed box — 20260917_220137, 20260918_215432), `PlayCard.tsx`, `card-face.css`, `lib/play/session.ts` + `priority-stops-session.ts` (the forced block declaration — 20260825_211445), `components/play/BoardScene.tsx` + `PlayBoard.tsx` + `online/OnlineBoard.tsx` (either seat’s graveyard opens — 20260907_190210), `opponent-feed.css` + `PlayBoard.tsx` (the feed lives in the log rail — 20260917_220347), tests beside each. DESIGN §3.176. | ✅ MERGED (#78) |
| feat/static-conditions | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"As long as …" — when a static is on (§3.169): one pre-pass, one closed table; +123 cards.** **packages/core**: NEW `static-conditions.ts` (+test; `StaticCondition`, `StaticCountSource`, `staticConditionHolds`), `statics.ts` (`StaticAbility.activeWhile`), `internal/continuous.ts` (`staticIsLive` — ONE liveness predicate at the bulk index, the per-permanent aggregate and the emblem fold), `card.ts` + `derived.ts` (`cardTypesInYourGraveyard`), `index.ts`. **packages/cards**: `compile/rules.ts` (`STATIC_CONDITION_SHAPES`, `stripStaticCondition`, `applyStaticCondition`, rule `static-self-modification`, the delirium count row), `compile/compile.ts` (the pre-pass in `applyRules`, STATIC rules only), NEW `compile/static-conditions.test.ts`. **apps/web**: `lib/play/keyword-glossary.ts` (Threshold, Delirium, Fateful hour). Generated data regenerated: 7,136 → 7,259 (+123), index 7,291/7,291. DESIGN §3.169. | ✅ MERGED (#73) |
| feat/enters-attached | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"When this Equipment enters, attach it to target creature you control" (§3.170) — one effect-rule row on the Equip path; +16 cards.** **packages/cards**: `compile/rules.ts` (rule `attach-self-to-target-creature-you-control`), NEW `enters-attached.test.ts` (Maul of the Skyclaves, played). **packages/sim**: `soak-config.ts` (`trigger-copy` gets the sequenced overtime lane — INERT on the larger pool, the §3.162 class). Generated data regenerated: 7,290 → 7,306 (+16), index 7,338/7,338. DESIGN §3.170. | ✅ MERGED (#74) |
| feat/self-keyword-grant | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"~ gains KEYWORD until end of turn" / "~ gets +N/+N and gains KEYWORD until end of turn" as an activated or triggered body, and HYBRID mana in an activation cost (§3.171) — +190 cards.** **packages/cards**: `compile/rules.ts` (rules `self-grant-keyword-until-eot`, `self-pump-and-grant-until-eot`), `compile/compile.ts` (`parseActivationMana` — the cast path's hybrid component table, Phyrexian and snow still refused), NEW `compile/self-keyword-grant.test.ts` (10), NEW `self-keyword-grant.test.ts` (2, played: Unyielding Krumar, Stream Hopper). Generated data regenerated: 7,306 → 7,496 (+190, nothing left), index 7,528/7,528. DESIGN §3.171. | ✅ MERGED (#75) |
| feat/discard-cost | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"Discard a card:" as an activation cost (§3.172) — `ActivationCost.discard`, one card named on the action, paid through the one discard funnel; +103 cards (7,496 → 7,599, nothing left; index 7,631/7,631).** **packages/core**: `card.ts` (the field), `engine.ts` (`discardCostCandidates`; the gate, the offer, the apply path; graveyard abilities refuse it), NEW `activation-discard-cost.test.ts` (6). **packages/cards**: `compile/rules.ts` (`DISCARD_COST_NOUNS`, shared with `COST_NOUNS`), `compile/compile.ts` (`DISCARD_ONE` in `parseActivationCost`; sacrifice+discard refused), NEW `discard-cost.test.ts` (5, Patrol Hound played). **packages/ai**: `activation-cost.ts` (the payer priced at `cardValue`), `heuristic.ts` (payer handed through), `mana-exchange.ts`, NEW `discard-cost-pilot.test.ts` (4). **packages/sim**: `soak-config.ts` + `soak.ts` (witness `discard-cost`), `observation.test.ts` (boundary row). DESIGN §3.172. | ✅ MERGED (#76) |
| feat/six-rows | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **Six one-row families from the one-clause ranking (§3.173): mass modification on the other board / every board, "target attacking or blocking creature", the "during your turn" static condition, "target creature can't block this turn", "return ~ to its owner's hand", two enters-tapped conditions; +181 cards (7,599 → 7,780, nothing left; index 7,812/7,812).** **packages/core**: `targeting.ts` (`attackingOrBlockingCreature`), `combat-removal.ts` (`blockingCreatureIds`), `static-conditions.ts` (`yourTurn`), `card.ts` (`anyPlayerLifeAtMost`, `minOpponents`; `EntersTappedContext.lifeTotals/opponentCount`), `engine.ts` (`entersTappedFacts`), NEW `six-rows-core.test.ts` (5). **packages/cards**: `compile/rules.ts` (rules `mass-modify-scoped-until-eot`, `grant-cant-block-until-eot`, `bounce-self`, `enters-tapped-unless-a-player-life-at-most`, `enters-tapped-unless-min-opponents`; the damage target row; the your-turn shapes), `primitives.ts` (scope `all`), `choice-primitives.ts` (`bounceSelf`), NEW `six-rows.test.ts` (11). **packages/ai**: `effect-value.ts` (`bounceSelf` priced). DESIGN §3.173. | ✅ MERGED (#77) |
| feat/activate-once-each-turn | DESKTOP-90PJPM4 (integrator, session 2b6c69aa) | **"Activate only once each turn" (§3.168) — picked from the one-clause measurement (77 cards named it; +31 compiled).** **packages/core**: `card.ts` (`ActivationRestriction` gains `onceEachTurn`), `state.ts` (`CardInstance.onceEachTurnActivated`, the loyalty-turn design), `engine.ts` (`unpayableActivationReason` takes the ability index; the apply path writes the turn), `internal/clone.ts`, `internal/zones.ts` (forgotten on a zone change), NEW `activation-once-each-turn.test.ts`. **packages/cards**: `compile/compile.ts` (`ACTIVATE_ONLY_ONCE_EACH_TURN` tail), `named-counters.test.ts` (+2). Generated data regenerated: 7,136 → 7,167 (+31), index 7,199/7,199. DESIGN §3.168. | ✅ MERGED (#72) |

| feat/copy-effects | worker | packages/core (NEW copy.ts + copy.test.ts; card/state/choices/events/engine/derived/index, internal clone+zones), packages/cards (compile rules +1 rule & 4 hints & parser block, compile/compile.ts, compile/types.ts, NEW compile/copy-effects.test.ts, fidelity.test.ts 1 line), packages/ai (choices/weights/index + NEW copy-target-pilot.test.ts), packages/sim (observation +1, paired-arms-config + paired-arms + its test), apps/web (about/mechanics +2 witnesses, play/choice-view +1 branch, lib/cards.ts +1 branch), DESIGN §3.24, COORDINATION | 🚧 PUSHED, not merged |

| feat/nonhand-casting | worker | packages/core (card/actions/state/events/choices/engine/index + internal/clone + test-fixtures + new flashback.test.ts), packages/cards (effect-helpers, compile types/rules/compile, index.ts STUBBED reword, data/pool.ts comments only, new flashback.test.ts), packages/ai (heuristic.ts + new flashback-pilot.test.ts), packages/sim (config/cli/swap + data/decks/uw-control — FIDELITY wording only), apps/web/src/lib/about/mechanics.ts, DESIGN §3.11, UNSUPPORTED-MECHANICS.md | 🚧 PUSHED, not merged |
| feat/cast-cost-modification | worker | packages/core (card/choices/state/effects/engine/index + internal/clone + new cast-cost.test.ts), packages/cards (effect-helpers/primitives/index; compile types+compile+rules + compile.test; new cast-cost-cards.test.ts), packages/ai (choices + heuristic + choices.test), packages/sim (paired-arms-config classification only), apps/web (play/choice-view + ChoicePrompt + choice tests, about/mechanics.ts), DESIGN §3.11, UNSUPPORTED-BACKLOG.md (regenerated) | 🚧 PUSHED, not merged |

| feat/planeswalkers | worker | packages/core (card/state/actions/events/targeting/engine/effects/serialize/index + internal stats/combat/sba/clone/zones + NEW planeswalker.test.ts), packages/cards (compile types/compile/rules loyalty + NEW rules, choice-primitives sacrificeChosen+pileSplitSacrifice, primitives dealDamage-to-walker, data/pool.ts Liliana + 2 refreshed expanded entries, index.ts STUBBED, NEW planeswalker-play.test.ts), packages/ai (heuristic walker attack/burn/loyalty + effect-value + weights + NEW planeswalker-pilot.test.ts), packages/data-tools (loyalty capture + Liliana index record), packages/sim (observation +2, paired-arms +2, fidelity copy), apps/web (play board walker UI + about/mechanics + card-index regen), DESIGN §3.9/§3.11, UNSUPPORTED-BACKLOG.md (regenerated) | 🚧 PUSHED, not merged |
| feat/scry-and-templates | worker | packages/core (choices.ts `keepOnTop`, events.ts `cardsLookedAt`), packages/cards (choice-primitives scry/surveil + `unlessPaidX`, compile/rules.ts 4 new rules + 1 hint reword, NEW compile/scry-surveil.test.ts), packages/ai (choices.ts keep-on-top branch + weights.ts `scryKeepValueThreshold` + choices.test additions), packages/sim (observation +1 classification, paired-arms +2), apps/web (play/choice-view copy, play-format log line, about/mechanics +2 witnesses), DESIGN §3.11 | 🚧 PUSHED, not merged |
| fix/scan-real-photo | worker | apps/web/src/lib/scan (config/detect/stacks/crop/ocr/match/pipeline + stacks.test rewrite + pipeline.test tweak + NEW real-photo.test.ts + NEW fixtures/user-deck-photo.jpg + fixtures/card-names-catalog.json), apps/web/package.json (+jpeg-js dev), package-lock.json, .gitignore (traineddata cache), DESIGN §3.12 | 🚧 PUSHED, not merged |
| feat/derived-state | worker | packages/core (NEW derived.ts + turn-facts.ts + derived-state.test.ts; card/choices/state/index/protection, internal/{continuous,stats,clone,triggers-runtime}, engine.ts one line), packages/cards (effect-helpers/primitives, compile/{rules,compile,types,text}, data/pool.ts Tarmogoyf+Fatal Push, src/index.ts STUBBED, NEW derived-state.test.ts + 3 refreshed tests), packages/sim (fidelity caveat wording only), apps/web/src/lib/about/mechanics.ts, DESIGN §3.11 | 🚧 PUSHED, not merged |
| feat/online-ui-parity | worker | apps/web (components/online/OnlineBoard.tsx, components/play/{PlayBoard,SeatPanel,GraveyardPanel NEW,AbilityPrompts NEW}.tsx, lib/online/{legal-actions,auto-tap,board-adapter}.ts, lib/play/{session,view-model,graveyard-cast NEW}.ts, styles.css appended), apps/server (room.ts constructor pool param + NEW online-ui-parity.test.ts), packages/protocol/src/index.test.ts (walker-visibility tests only), DESIGN §3.14 | 🚧 PUSHED, not merged |
| feat/graveyard-grants | worker | packages/core (NEW card-grants.ts + card-grants.test.ts + bench/scavenge-probe.ts; targeting/state/events/engine/index + internal clone/zones), packages/cards (primitives grantFlashback + compile/rules new rule & 2 reworded hints + effect-helpers prune + index un-stub + data/pool.ts Snapcaster + NEW graveyard-grants.test.ts), packages/ai (effect-value/heuristic/weights + NEW graveyard-grant-pilot.test.ts), packages/sim (paired-arms +1, observation +2, uw-control comment), apps/web (about/mechanics +2 witnesses), DESIGN §3.11, UNSUPPORTED-MECHANICS.md | 🚧 PUSHED, not merged |
| feat/battles-legend-emblems | worker | packages/core (card/state/events/choices/targeting/effects/engine/serialize/index + internal stats/combat/sba/continuous/triggers-runtime + NEW battle.test/legend-rule.test/emblem.test), packages/cards (primitives createEmblem + compile compile/rules/text/types + data/pool.ts Liliana legendary + NEW battles-legend-emblems.test), packages/data-tools (defense capture), packages/sim (paired-arms +1, observation +4), packages/ai (heuristic attack planner + weights + NEW battle-pilot.test), apps/web (view-model/board-adapter/BoardPermanentTile/planeswalker.css + about/mechanics + its test), DESIGN §3.15 | 🚧 PUSHED, not merged |

| feat/mana-ability-model | worker | packages/core (card.ts mana model + engine.ts offer/apply + mana-plan.ts + index.ts + NEW mana-ability-model.test.ts), packages/cards (compile/rules.ts MANA_RULES +5 & UNSUPPORTED_HINTS reworded, compile/compile.ts + types.ts assembly, mana-templates.test.ts rewritten, 2 compile.test.ts cases), packages/ai (NEW mana-ability-pilot.test.ts only), apps/web/src/lib/about/mechanics.ts (+2 witnesses), DESIGN §3.11, COORDINATION | 🚧 PUSHED, not merged |
| fix/keyword-sweep-and-mana-templates | worker | packages/cards (compile/compile.ts keyword-sweep guard, compile/rules.ts 1 new MANA_RULES entry + 5 new UNSUPPORTED_HINTS above the mana hint, compile/scry-surveil.test.ts additions, NEW compile/mana-templates.test.ts), apps/web/src/lib/about/mechanics.ts (+1 witness), DESIGN §3.11, docs/plans/mechanic-completion-plan.md, COORDINATION.md. **No engine change.** | 🚧 PUSHED, not merged |
| feat/mana-spend-restrictions | worker | packages/core (NEW spend-restriction.ts + spend-restriction.test.ts + clone.test.ts; mana.ts, mana-plan.ts, card.ts, engine.ts, events.ts, serialize.ts, index.ts, internal/clone.ts), packages/cards (compile/rules.ts + NEW compile/spend-restriction.test.ts + mana-templates.test.ts rewording; primitives.ts one guard), packages/ai (heuristic.ts + land-sequencing.ts call sites; NEW spend-restriction-pilot.test.ts), packages/sim/src/observation.ts (comment only), packages/protocol/src/index.ts (comment only), apps/web (lib/play/{session,view-model}.ts, lib/online/{auto-tap,board-adapter}.ts, lib/replay-build.ts, components/play/SeatPanel.tsx, styles.css, lib/about/mechanics.ts), DESIGN §3.11 (the mana list), COORDINATION | 🚧 PUSHED, not merged |
| docs/mechanic-census | worker | **DOCS + GENERATED DATA ONLY** — docs/plans/mechanic-completion-plan.md (new), UNSUPPORTED-BACKLOG.md (regenerated from a live fetch), UNSUPPORTED-MECHANICS.md (pointers + audit usage), packages/cards/scripts/coverage-audit.mjs (`--top`/`--json`/`--save-corpus` + per-gap `kind`), COORDINATION.md. **No engine, compiler, or pool change** — collides with nobody. | 🚧 PUSHED, not merged |
| feat/modal-casting | worker | packages/core (NEW modal.ts + modal-casting.test.ts; card/state/actions/choices/effects/mana/targeting/engine/index, internal clone+zones, derived), packages/cards (compile rules/compile/types/text + effect-helpers + choice-primitives (modal primitive REMOVED) + index + data/pool Cryptic + 6 tests), packages/ai (choices/effect-value/heuristic + tests), packages/sim (observation +2 events, paired-arms note, pilot-choices test), apps/web (choice-view/ChoicePrompt/AboutView/mechanics + online legal-actions + play/session + 3 tests), DESIGN §3.16, COORDINATION | 🚧 PUSHED, not merged |
| feat/you-may-and-trigger-templates | worker | packages/core (card.ts `basic`/`entersTappedUnlessRevealed`/`canRevealForUntapped`, choices.ts CardFilter P/T bounds, triggers.ts +5 TriggerEvents + `TriggerSubject`, internal/triggers-runtime.ts subject resolver, engine.ts reveal-land question + its answer branch, index.ts +2 exports, conditional-tapland.test.ts), packages/cards (primitives `mayEffects` + loseLife `whichPlayer`, choice-primitives tapPermanents untap/excludeTypes, compile/{rules,compile,types}.ts + NEW compile/you-may-and-triggers.test.ts, data/pool.ts basics only), packages/sim (paired-arms-config classification only), apps/web/src/lib/about/mechanics.ts (+6 witnesses), DESIGN §3.11, COORDINATION | 🚧 PUSHED, not merged |
| feat/indestructible-and-blocking | worker | packages/core (card.ts KeywordFlags +3, internal/{sba,combat,stats,continuous}.ts, NEW indestructible.test.ts, blocking-restrictions.test.ts extended), packages/cards (primitives.ts destroy exemption + NEW grantKeywordToYoursUntilEndOfTurn, index.ts, compile/rules.ts +4 rules & 1 hint reword & 2 generalised rules, compile.test.ts reword, NEW indestructible-and-blocking.test.ts), packages/ai (heuristic.ts, effect-value.ts, NEW indestructible-blocking-pilot.test.ts), packages/sim/src/paired-arms-config.ts (+1 classification), apps/web/src/lib/about/mechanics.ts (+4 witnesses), DESIGN §3.17 | 🚧 PUSHED, not merged |

| feat/pool-expansion | worker | packages/cards (data/expansion-candidates.json + GENERATED data/expanded-pool.ts, data/expansion-report.json; src/primitives.ts addCounters fix; src/fidelity.test.ts, src/pool.test.ts, src/expanded-pool.test.ts; NEW src/pool-mechanics.test.ts), packages/data-tools/data (card-index.json + starter-cards.json, re-fetched), apps/web/src/data/card-index.json (regenerated), DESIGN §3.20, COORDINATION. **No compiler rule, no engine change beyond the one-line counters fix.** | 🚧 PUSHED, not merged |
| feat/alternative-costs | worker | packages/core (NEW madness.ts + alternative-costs.test.ts; card/state/actions/events/choices/engine/index, internal zones+clone, flashback.test call sites), packages/cards (compile rules 4 new STATIC_RULES + 1 hint reword, compile/compile.ts assembly + cycling keyword-sweep guard, compile/types.ts, effect-helpers discard funnel + counter reason, NEW alternative-costs.test.ts), packages/ai (heuristic cycling policy + madness decision, weights 3 entries, mcts/search-stats action-kind switches, NEW alternative-costs-pilot.test.ts), packages/sim (paired-arms effect scan + observation 3 events), apps/web (play/session cycle+exile casts, PlayBoard hand menu + madness prompt, about/mechanics 4 witnesses), DESIGN §3.18 + §3.11 open-list, COORDINATION | 🚧 PUSHED, not merged |
| fix/ai-sees-continuous-effects | worker | packages/ai (NEW board-stats.ts + bare-stats.test.ts; heuristic/evaluator/mcts/tactical/effect-value/card-value/choices + tactical.test), packages/sim/src/pilot-quality.test.ts (3 new guards), DESIGN §3.4a/§3.4f/§3.11, COORDINATION | 🚧 PUSHED, not merged — **re-measures every recorded heuristic baseline** |
| test/full-pool-soak | worker | packages/sim (NEW soak.ts + soak-config.ts + soak-decks.ts + soak.test.ts + soak-deep.test.ts; cli.ts `soak` command; index.ts exports), packages/ai (heuristic.ts — 4 small hunks + 1 import; indestructible-blocking-pilot.test.ts +3 cases; flashback-pilot.test.ts +3 cases), packages/core (engine.ts — ONE `checkStateBasedActions` call in `applyCastSpell`; flashback.test.ts +3 cases; sba.test.ts +1 case), DESIGN §3.26, TESTING.md, COORDINATION. **No pool change, no meta-deck change, no compiler rule.** The two core edits are both state-based-action passes in `applyCastSpell`; they emit nothing unless something actually dies, and no gauntlet deck contains a card that can make one fire (measured — see the note below), so every recorded baseline is unmoved. | 🚧 PUSHED, not merged |
| feat/step-trigger-templates | worker | packages/core (NEW intervening.ts + step-triggers.test.ts; triggers/state/choices/effects/events/engine/index + internal triggers-runtime & clone), packages/cards (compile/rules.ts, primitives, choice-primitives, effect-helpers, index + NEW compile/step-trigger-templates.test.ts + 2 flipped tests), packages/sim (paired-arms-config +1, observation +1), apps/web/src/lib/about/mechanics.ts (3 witnesses), DESIGN §3.21 | 🚧 PUSHED, not merged |
| feat/split-cards | worker | packages/core (card.ts/card-grants.ts/actions.ts/state.ts/engine.ts + internal/sba.ts + index.ts + NEW split-cards.test.ts + 1 test literal in alternative-costs.test.ts), packages/cards (compile/compile.ts + compile/index.ts + index.ts + NEW compile/split-cards.test.ts + 3 stale test claims + 1 pool-mechanics reason), packages/data-tools (normalize.ts + types.ts - `layout` capture), packages/ai (heuristic.ts + NEW split-cards-pilot.test.ts), apps/web (lib/play/session.ts, components/play/PlayBoard.tsx, lib/about/mechanics.ts + NEW lib/play/split-cards-session.test.ts), DESIGN §3.21 + §3.11 open-list, COORDINATION | 🚧 PUSHED, not merged |

| feat/as-enters-choices | worker | packages/core (NEW as-enters.ts + as-enters.test.ts; card/choices/state/statics/triggers/effects/events/engine/index, internal clone+zones+triggers-runtime), packages/cards (choice-primitives `chooseAsEnters`, compile rules/compile/types + NEW as-enters-cards.test.ts), packages/ai (choices.ts + NEW as-enters-pilot.test.ts), packages/sim (observation +1, paired-arms +1), apps/web (play/choice-view + ChoicePrompt + styles.css + play-format + replay-format + about/mechanics + 2 tests), DESIGN §3.21, COORDINATION | 🚧 PUSHED, not merged |
| feat/tutor-and-sacrifice-templates | worker | packages/core (card.ts `AdditionalCastCost`, state.ts stack field, engine.ts cast gate + cost question + payment, index.ts export, internal/clone.ts +1 field, NEW additional-cast-cost.test.ts), packages/cards (choice-primitives searchLibrary `route`/graveyard, compile/{rules,compile,types}.ts, NEW tutors-and-additional-costs.test.ts, 1 reworded template-gaps case), packages/ai (choices.ts tutor-reach policy + weights.ts +2 entries + choices.test additions), packages/sim/src/paired-arms-config.ts (COMMENT only), apps/web/src/lib/about/mechanics.ts (+3 witnesses), DESIGN §3.11, COORDINATION | 🚧 PUSHED, not merged |
| test/interaction-matrix | worker | **NEW files only** — `packages/cards/src/interaction/` (harness.ts + 8 pair suites + interaction-matrix.test.ts) — plus THREE product fixes: `packages/core/src/internal/continuous.ts` (new `anyContinuousModification`), `packages/core/src/protection.ts` + `targeting.ts` (fast-path gate), `packages/cards/src/effect-helpers.ts` (`movePermanentTo` calls the shared reset), `packages/core/src/index.ts` (+1 export), TESTING.md, COORDINATION.md | 🚧 PUSHED, not merged |
| feat/replacement-effects | worker | packages/core (NEW replacement.ts + internal/replacement.ts + replacement.test.ts; card.ts `replacements`, state.ts `replacements`, events.ts +2, effects.ts `addReplacementEffect`, turn-facts.ts +1 fact, engine.ts draw+cleanup, index.ts exports, internal/{clone,combat,sba}.ts), packages/cards (primitives.ts damage/counters/draws + NEW `preventDamage`, compile/{rules,compile,types}.ts, NEW replacement-effects.test.ts), packages/ai (heuristic.ts fog intent + incoming damage, tactical.ts attacker re-pricing, weights.ts +2, effect-value.ts +1, NEW replacement-pilot.test.ts), packages/sim (observation +2, paired-arms +1), apps/web/src/lib/about/mechanics.ts (+3 witnesses), DESIGN §3.29, COORDINATION | 🚧 PUSHED, not merged |

| test/rules-conformance | worker | packages/core/src/conformance (NEW: manifest-types.ts, rules-manifest.ts, manifest.test.ts, cr7xx-sba-keywords-copy.test.ts + 4 salvaged cr*.test.ts and harness.ts), TESTING.md, DESIGN §3.21, COORDINATION.md. **No engine, compiler or pool change — collides with nobody.** | 🚧 PUSHED, not merged |

| feat/combat-damage-and-equipment | worker | packages/core (triggers.ts `TriggerWatches`/`watches`/`TriggerSource.permanent`, internal/triggers-runtime.ts, index.ts +2 exports, NEW equipped-triggers.test.ts), packages/cards (compile/rules.ts 6 new TRIGGER_RULES + 3 new EFFECT_RULES + `optionalTriggerFrom`/`hostWatch`/payload-keyword parsing + 2 hint rewords, compile/compile.ts host-watch assembly guard, compile/attachments.test.ts 1 obsoleted case, NEW equipped-triggers.test.ts), packages/ai (heuristic.ts equip search + attack value + walker diversion, weights.ts +2 knobs, NEW equipment-pilot.test.ts), apps/web/src/lib/about/mechanics.ts (+2 witnesses, 1 reworded), DESIGN §3.29, COORDINATION. **No new effect primitive, no new GameEvent, no pool change.** | 🚧 PUSHED, not merged |
| feat/block-requirements-and-statics | worker | packages/core (NEW block-solver.ts + countering.ts + player-statics.ts + block-requirements.test.ts + bench/block-requirement-cost.ts; card/actions/choices/config/engine/events/index, internal combat+continuous+stats+clone, conformance/rules-manifest, selfplay-lock re-pinned, 6 test helpers), packages/cards (compile rules/compile/types + effect-helpers + NEW block-and-statics.test.ts + 3 reworded tests), packages/ai (heuristic/weights + NEW block-requirements-pilot.test.ts), packages/sim (soak-config +3 classifications, observation +1), apps/web (about/mechanics +6 witnesses, play-format +1), DESIGN §3.25 | 🚧 PUSHED, not merged — **contains the fix for main's currently RED build** (soak-config) |
| feat/pool-expansion-2 | worker | packages/cards (data/expansion-candidates.json + GENERATED data/expanded-pool.ts + data/expansion-report.json; scripts/build-expansion.ts front-face lookup; src/pool-mechanics.test.ts REWRITTEN inventory + 12 new play tests, src/pool.test.ts counts, src/expanded-pool.test.ts mana cap, src/attachment-cards-in-pool.test.ts +4 PRINTED rows), packages/data-tools (src/normalize.ts + types.ts per-face defense/loyalty + adventurer cost, src/verify.ts + index.ts `frontFaceName`, src/normalize.test.ts +5, GENERATED data/card-index.json + data/starter-cards.json), apps/web/src/data/card-index.json (regenerated), packages/core (engine.ts `unpayableAdditionalCostReason` EXPORTED + index.ts +1 export — no behaviour change), packages/ai (heuristic.ts: additional-cost goal filter + `equipIsAnUpgrade`; equipment-pilot.test.ts +3; NEW additional-cost-pilot.test.ts), packages/sim/src/soak-config.ts (ONE predicate), DESIGN §3.20, COORDINATION. **No compiler rule, NO meta deck touched; gauntlet seed 99 byte-identical.** | 🚧 PUSHED, not merged |

| fix/token-characteristics | worker | packages/core (card/choices/events/index/derived, internal/zones + clone COMMENT ONLY, NEW token-clone.test.ts), packages/cards (primitives, effect-helpers, compile/rules + compile/compile, data/pool.ts + REGENERATED data/expanded-pool.ts & expansion-report & expansion-candidates, NEW token-characteristics.test.ts + 4 updated tests), packages/data-tools (src/client.ts + regenerated data/), packages/sim/src/observation.ts (+1 classification), apps/web (about/mechanics.ts + regenerated src/data/card-index.json), DESIGN 3.29 | PUSHED, not merged |
| feat/spell-and-token-copies | worker | packages/core (NEW spell-copy.ts + spell-copy.test.ts; copy.ts `tokenCopyDefOf`, state.ts `isSpellCopy` + `spellLeaveDestination`, engine.ts finishSpellResolution/targetOptionFor/selectTargets guard, targeting.ts `instantOrSorcerySpell`, events.ts +3, choices.ts resolvesTo, index.ts, internal/clone.ts +1 field), packages/cards (NEW copy-primitives.ts + copy-play.test.ts; primitives.ts registry line, effect-helpers.ts counter exit, compile/rules.ts 2 rules + 2 reworded hints + TOKEN_COPY_SELECTORS, compile/copy-effects.test.ts flipped, pool.test.ts count, pool-mechanics.test.ts +2 inventory, GENERATED data/*), packages/ai (choices.ts re-aim policy, effect-value.ts +3 valuers, heuristic.ts `copySpell` intent, NEW copy-spell-pilot.test.ts), packages/sim (observation +3, soak-config +2 mechanics & +3 witnesses & tightened `copy-effect` predicate, paired-arms-config +3 SAFE), packages/data-tools/data (regenerated), apps/web (about/mechanics +2, play-format + replay-format +3 lines, data/card-index regenerated), DESIGN §3.31, COORDINATION | 🚧 PUSHED, not merged |

| fix/max-hand-size-and-sba | worker | packages/core (`internal/sba.ts` CR 704.5q + the CR 704.3 gate + `resolveWinner`; `engine.ts` boundary call + CR 514.3a re-entrant cleanup + `NO_ASKING_OBJECT` source; `choices.ts` the sentinel; `index.ts` +2 exports; NEW `bench/sba-gate-cost.ts`; `sba.test.ts`, `selfplay-lock.test.ts` re-pinned, `planeswalker.test.ts` turn-runner, conformance `cr4xx`/`cr5xx`/`cr7xx` + `rules-manifest.ts`), packages/cards (`primitives.ts` persist counter kind + the primitive stops annihilating, `counters.test.ts`, `engine-cards.test.ts`, 3 interaction cells + the GAP register), packages/ai (`choices.ts` the discard policy written out + `choices.test.ts`), packages/sim (`paired-arms-config.ts` comment only), DESIGN §3.29 + §3.4a + §3.28, COORDINATION | 🚧 PUSHED, not merged |
| fix/redaction-guarantee | worker | packages/core (NEW `instance-ids.ts` + `instance-ids.test.ts`, `index.ts` +4 exports — **no engine behaviour change**), packages/protocol (`index.ts` `collectInstanceIds` widened, `index.test.ts` +3), packages/sim (`observation.ts` the shared scanner + the guarantee restated, `observation.test.ts` REWRITTEN onto soak-anchored decks, `soak.ts` uses the shared scanner + reports `leakScanObservations`, `soak-config.ts` leak sampling 31→1, NEW `masking.test.ts`), apps/server (`security.test.ts` drops its local narrow copy), DESIGN §3.30, TESTING.md, COORDINATION | 🚧 PUSHED, not merged |
| fix/sba-toughness-violation | worker | packages/core (`engine.ts` — the CR 704.3 check moved to the END of every action in `applyActionToDraft`; `sba.test.ts` +1), packages/sim (`soak.ts` NEW `replaySoakMixedGame` + `SoakReplayResult` + `describeMatchup`, `soak.test.ts` NEW pinned-replay block), DESIGN §3.32 (+ §3.30's deferral note closed), COORDINATION. **Gauntlet seed 99 byte-identical (79/280).** | ✅ MERGED + DEPLOYED |
| feat/play-vs-ai | DESKTOP-90PJPM4 (worker) | apps/web ONLY (lib/play/seat.ts +solo transport, NEW lib/play/ai-seat.ts + test, lib/play/play-config.ts +2 knobs, views/PlayView.tsx, components/play/SetupScreen.tsx, components/lab/PilotControls.tsx label prop, styles.css +1 rule), DESIGN §3.43, COORDINATION | ✅ MERGED + DEPLOYED |
| fix/blink-aim | DESKTOP-90PJPM4 (worker) | packages/ai/src/effect-value.ts (+2 value entries: mayEffects recursion, blinkTarget), NEW packages/ai/src/blink-value.test.ts, DESIGN §3.42, COORDINATION | ✅ MERGED + DEPLOYED |
| fix/pilot-blink-weak-rows | DESKTOP-90PJPM4 (worker) | packages/ai ONLY (NEW combat-math.ts + combat-math.test.ts + combat-math-pilot.test.ts; heuristic.ts — one import, the `pickBlocker` value line, and a ⚠️ doc-comment on `attackIsProfitable`; weights.ts +1 weight), DESIGN §3.45, COORDINATION. **No core, cards, sim or web change.** ⚠️ **MOVES two recorded baselines**: Mono-Green Ramp 491 → 537/800 and UW Control 426 → 413/800. Mono-Red Aggro byte-identical (224/800). | ✅ MERGED + DEPLOYED |
| feat/angels | DESKTOP-90PJPM4 (worker) | packages/core (targeting.ts +1 multi-zone restriction across all five homes, triggers.ts +targetCount, state.ts + internal/triggers-runtime.ts + internal/clone.ts threading, engine.ts trigger aiming reads a range), packages/cards (exile-until-leaves.ts graveyard path, NEW angel-of-serenity.test.ts, compile/rules.ts +1 rule, pool.test.ts count, data/expansion-candidates.json + GENERATED data/*), packages/data-tools/data (GENERATED), apps/web/src/data/card-index.json (GENERATED), DESIGN §3.41, COORDINATION | ✅ MERGED + DEPLOYED |
| feat/pilot-pays-for-abilities | DESKTOP-90PJPM4 (worker) | packages/core/src/targeting.ts (ONE line — the missing validator entry), packages/ai/src/heuristic.ts (NEW bestFundedActivation + wiring in choosePriorityAction), packages/sim/src/soak-config.ts (trigger-copy re-registered as a witnessed mechanic), packages/sim/src/loop-draw.test.ts (rewritten to pin the mechanism), DESIGN §3.40 + §3.39 correction, COORDINATION | ✅ MERGED + DEPLOYED |
| feat/copy-triggered-ability | DESKTOP-90PJPM4 (worker) | packages/core (targeting.ts +triggeredAbilityYouControl, events.ts +triggerCopied, instance-ids.ts), packages/cards (NEW trigger-copy-primitives.ts + trigger-copy.test.ts, compile/rules.ts +1 effect rule, primitives.ts, pool.test.ts count, GENERATED data/*), packages/ai (effect-value.ts +copyTriggeredAbility), packages/sim (config.ts +maxActionsPerTurn, match.ts loop outcome, soak.ts loopDraws, soak-config.ts, paired-arms-config.ts, NEW loop-draw.test.ts), apps/web GENERATED card-index.json, DESIGN §3.39, COORDINATION | ✅ MERGED + DEPLOYED |
| fix/play-reports | DESKTOP-90PJPM4 (integrator) | apps/web (PlayView, MulliganScreen, PlayBoard, OnlineBoard, PlayCard, NEW AiMulliganScreen + CardZoomOverlay + lib/play/solo-screen(+test), lib/online/drag-to-play+useDragToPlay MOVED to lib/play, styles.css play section, play-config/online-config const move), DESIGN §3.51, COORDINATION | ✅ MERGED |
| fix/play-imported-decks | DESKTOP-90PJPM4 (integrator) | apps/web/src/lib/play/setup.ts, apps/web/src/components/online/OnlinePlay.tsx, NEW apps/web/src/lib/play/imported-deck-playable.test.ts, DESIGN §3.48, COORDINATION | ✅ MERGED + DEPLOYED |
| feat/card-templates | DESKTOP-90PJPM4 (worker) | packages/cards (NEW exile-until-leaves.ts + test, compile/rules.ts +6 rules, primitives.ts registration, pool.test.ts count, GENERATED data/*), packages/core (targeting.ts +2 restrictions + optional exclude param, triggers.ts +targetsExcludeSelf, state.ts + internal/triggers-runtime.ts + internal/clone.ts threading, engine.ts trigger targeting), apps/web (lib/decklist/importedCards.ts re-compile on load; GENERATED src/data/card-index.json), packages/data-tools/data (GENERATED), DESIGN §3.38, COORDINATION | ✅ MERGED + DEPLOYED |
| fix/pool-shadowed-by-import | DESKTOP-90PJPM4 (integrator) | apps/web (`lib/decklist/importedCards.ts` pool-first + NEW poolBeatsImport.test.ts; GENERATED src/data/card-index.json), packages/core (`targeting.ts` +1 restriction), packages/cards (`compile/rules.ts` +1 rule, `pool.test.ts` count, NEW restoration-angel.test.ts, GENERATED data/expanded-pool.ts + expansion-report.json), packages/data-tools/data (GENERATED), packages/sim (selesnya-blink.ts), DESIGN §3.37, COORDINATION | ✅ MERGED + DEPLOYED |
| fix/returned-spell-keeps-back-face | DESKTOP-90PJPM4 (worker) | packages/cards (`copy-primitives.ts` returnSpellToHand reset + NEW returned-spell-face.test.ts + NEW granted-flashback-split.test.ts), packages/core (`engine.ts` ONE line — the flashback-grant accessor), DESIGN §3.34 rewritten + §3.36 + §3.33 pointer, COORDINATION. **Deep tier GREEN: 0/2000.** | ✅ MERGED + DEPLOYED |
| feat/blink-selesnya | DESKTOP-90PJPM4 (worker) | packages/cards (NEW blink-primitives.ts + blink-play.test.ts; primitives.ts registration, effect-helpers.ts +1 option, compile/rules.ts +1 rule; GENERATED data/expanded-pool.ts + expansion-report.json + expansion-candidates.json), packages/data-tools/data (GENERATED card-index.json + starter-cards.json), apps/web/src/data/card-index.json (regenerated), packages/ai (heuristic.ts blink goal + picker), packages/sim (NEW data/decks/selesnya-blink.ts + decks/index.ts), DESIGN §3.35 + §3.21 note, COORDINATION. **Gauntlet seed 99 rows byte-identical; new 8th row.** | ✅ MERGED + DEPLOYED |
| fix/soak-action-cap | DESKTOP-90PJPM4 (worker) | packages/ai (`effect-value.ts` copySpell chain pricing + `willFizzleOnResolution`; `weights.ts` +1 weight; NEW `copy-chain-pilot.test.ts`), packages/cards (`copy-primitives.ts` CR 707.10 `min`; NEW `copy-retarget-optional.test.ts`), packages/sim (`soak.test.ts` +3 pinned rows), DESIGN §3.33 (+ §3.32's handoff closed), COORDINATION. **Gauntlet seed 99 byte-identical (79/280).** | 🚧 PUSHED, not merged |
| fix/blink-rules-fidelity | worker | packages/core (NEW `combat-removal.ts`; `state.ts` +`CombatState.removedFromCombat`, `attachments.ts` +`unattachDependentsOf`, `internal/continuous.ts` +`dropContinuousEffectsFor`, `internal/combat.ts` damage step, `internal/clone.ts`, `internal/replacement.ts` `isAttacking`, `engine.ts` 3 lines in declare-blockers, `instance-ids.ts` +1 field name, `index.ts` exports), packages/cards (`blink-primitives.ts` +3 calls + doc; `data/pool.ts` +10 printed `subtypes` lines; `fidelity.test.ts` +1 standing type-line guard; `restoration-angel.test.ts` +1 case; NEW `selesnya-blink-fidelity.test.ts`), DESIGN §3.44, COORDINATION. **No generated data regenerated; no soak or gauntlet row moved.** | ✅ MERGED + DEPLOYED |
| feat/pilot-ab-harness | worker | packages/sim ONLY (NEW `pilot-ab.ts` + `pilot-ab.test.ts`; `cli.ts` — new `pilot-ab` subcommand, `--pilot-a`/`--pilot-b`, and a shared `resolvePilot` helper the old `resolvePilots` now reuses; `index.ts` exports), DESIGN §3.46, COORDINATION. **No core, cards, ai or web change — NO pilot behaviour touched.** Adds a tool, moves no baseline. | 🚧 PUSHED, not merged |
| test/completeness-invariants | worker | TEST FILES ONLY (NEW: packages/core/src/targeting-completeness.test.ts, packages/cards/src/zone-leave-invariants.test.ts + pool-frame-integrity.test.ts, packages/ai/src/effect-value-parity.test.ts, packages/sim/src/offer-apply-exhaustive.test.ts, apps/web/src/lib/decklist/poolAlwaysPlayable.test.ts) + two EXPORT-ONLY runtime lists (packages/core/src/targeting.ts `ALL_TARGET_RESTRICTIONS`, packages/ai/src/effect-value.ts `PRICED_PRIMITIVE_IDS` — no index.ts change, tests import the modules directly), DESIGN §3.49, COORDINATION. **No behaviour change — no baseline can move.** All EIGHT §3.37–§3.45 fixes reverted one at a time: the generic layer went red every time (table in §3.49). | 🚧 PUSHED, not merged |
| feat/fast-lookahead | worker | packages/ai (NEW `combat-forecast.ts` + `lookahead.ts` + `combat-forecast.test.ts` + `lookahead-pilot.test.ts`; `index.ts` registration/exports; `heuristic.ts` — `export` added to five existing combat helpers + one doc note, NO behaviour change), packages/sim/src/paired-arms.test.ts (ONE classification line its new-pilot guard demands), apps/web/src/lib/sim/pilots.ts (the TWO data rows — `PILOT_COPY` + `RELATIVE_GAME_COST` — that `pilots.test.ts` demands for any new selectable pilot, measured figures only) + apps/web/src/lib/play/ai-seat.ts (one id-list comment un-staled), DESIGN §3.47, COORDINATION. **Default pilot untouched; gauntlet seed-99 baselines re-measured byte-identical (224/575/413/537 per 800).** | 🚧 PUSHED, not merged |
| fix/tmb-ui-findings | worker | apps/web ONLY (styles.css nav-overflow cues + `.result-count` token, views/about.css stat tiles, components/bug-reporter.css launcher, App.tsx nav wrap + measure effect, NEW lib/nav-overflow.ts + lib/contrast.ts + their tests, NEW styles-regressions.test.ts) + testmebro/findings/* bookkeeping, COORDINATION. **No packages/* change.** Fixes TMB-JB-0001..0004. | 🚧 PUSHED, not merged |
| perf/sim-throughput | worker | packages/sim (NEW `parallel-config.ts` + `parallel-slices.ts` + `parallel-host.ts` + `parallel-worker.ts` + `parallel.test.ts` + `parallel-host.test.ts`; `cli.ts` `--workers` + async commands; `pilot-ab.ts` slice/fold/finish refactor; `soak.ts` anchored/mixed-range/finish split — both behaviour-pinned unchanged), packages/core (`triggers.ts` watch masks + `internal/triggers-runtime.ts` `SOURCE_SET_EVENTS` + `internal/sba.ts` gate memo + NEW `trigger-event-prefilter.test.ts` — profiled cuts, NO behaviour change: seed-99 rows 257/615/377/552 per 800 byte-identical, selfplay-lock digests + match-inplace + pilot-ab control green), DESIGN §3.53, COORDINATION. **Does NOT touch packages/ai** (concurrent agent owns it). | 🚧 PUSHED, not merged |
| (fix/duplicate-printings) | DESKTOP-90PJPM4 (integrator) | apps/web ONLY (lib/cards.ts name-dedupe + `getCardByName`, lib/cards/addSingleCard.ts by-name known check, addSingleCard.test.ts fixture rename + new case, NEW lib/duplicate-printings.test.ts), DESIGN §3.55, COORDINATION | ✅ committed direct to main |
| feat/pilot-pricing | worker | packages/ai ONLY (`effect-value.ts` — `LEDGERED_EFFECT_VALUE` prices for 14 of the §3.49 ledger's 20 rows + the one-read gate + `LEDGER_PRICING_OFF_WEIGHTS`; `weights.ts` +7 named weights; `choices.ts` `answerSelectTargets` up-to-N clamp; `index.ts` one export-from line; `effect-value-parity.test.ts` ledger 20→6, `attachToTarget` reason rewritten to the measured one; NEW `ledger-pricing.test.ts` 32 tests), DESIGN §3.52, COORDINATION. **No core, cards, sim or web change.** ⚠️ Seed-99 baselines BYTE-IDENTICAL (257/615/377/552 per 800) and the 9-deck pilot-ab is byte-identical too (3600/3600 slots split — the meta holds ONE card that touches these prices); the strength case is the targeted `runPilotAb` STRONGER p≈0 in §3.52. | ✅ MERGED + DEPLOYED |
| feat/game-resume | worker | apps/web ONLY (lib/play/session.ts — the action log; NEW lib/play/persist.ts + persist.test.ts; NEW lib/update/update-decision.ts + updater.ts + both tests; NEW components/UpdatePill.tsx + components/update-pill.css; NEW views/play-resume.css; views/PlayView.tsx resume wiring; main.tsx SW-update flow; lib/config.ts keys; NEW scripts/verify-game-resume.mjs — the browser E2E harness, 18 checks). ⚠️ MINIMAL shared-file touches, noted here per the rules: `App.tsx` (initial view from the update-resume flag + screen reporting + one `<UpdatePill/>` mount — does NOT touch nav/measure logic), `vite.config.ts` (`registerType: 'autoUpdate'` → `'prompt'` — one value; see §3.58 for why autoUpdate cannot defer safely), and `eslint.config.js` (the existing puppeteer-harness globals block gains the new harness + 2 globals). Does NOT touch components/play/* or styles.css (concurrent §3.57 agent owns those); lib/play/setup.ts was claimed but needed NO change. DESIGN §3.58, COORDINATION | ✅ MERGED |

| feat/play-clarity | worker | apps/web ONLY — components/play/** (ChoicePrompt, AbilityPrompts, SeatPanel, BoardPermanentTile, PlayBoard + NEW AnimationLayer.tsx + CombatLines.tsx + jail-tile.test.ts), components/online/OnlineBoard.tsx, lib/play/** NEW option-labels/jail-view/animations/combat-lines/action-hints (+5 test files) + play-config.ts anim knobs (NOT session.ts / setup.ts — the game-persistence agent owns those two; view-model untouched too), styles.css (play-clarity section, appended), DESIGN §3.57, COORDINATION | ✅ MERGED |

| fix/report-sweep | worker | apps/web ONLY, all NON-Play surfaces. **Type chips:** `lib/filter.ts` + `filter.test.ts`. **Transport icons:** `lib/replay-config.ts` + `components/match/PlaybackControls.tsx` + NEW `lib/replay-transport.test.ts`. **Per-deck-entry printings:** NEW `lib/printings/entryPrinting.ts` + `entryPrinting.test.ts`, `lib/deck.ts`, `lib/storage.ts` + NEW `storage.test.ts`, `lib/useDecks.ts`, NEW `components/DeckEntryPrinting.tsx`, `views/DeckBuilderView.tsx`, `views/ProxiesView.tsx` (the deck→sheet art bridge, inside `loadDeck` only), `styles.css` (own `report-sweep` section appended at EOF). **Deck entries remember their card name** (`DeckEntry.name`, the `unknown card "<uuid>"` report): `lib/deck.ts`, `lib/storage.ts`, `lib/decklist/buildDeck.ts` + `gauntletDecks.ts` + `applySwapToDeck.ts` (one entry-construction line each), NEW `lib/deck-entry-names.test.ts`. DESIGN §3.61, COORDINATION. ⚠️ **Touches NOTHING under views/PlayView.tsx, components/play/**, components/online/**, lib/play/**, lib/online/** or packages/core/src/mana-plan.ts** — the concurrent mana/cast agent owns those. | ✅ MERGED + DEPLOYED |

| feat/mana-choice | worker | packages/core (NEW mana-source-preference.ts + test; mana-plan.ts + mana-plan.test.ts; index.ts exports), packages/ai (NEW mana-preference.ts; weights.ts one flag, heuristic.ts + land-sequencing.ts call sites, index.ts export), apps/web (NEW lib/play/mana-picker.ts + mana-choice-pref.ts + mana-picker.test.ts + components/play/mana-picker.css; lib/play/session.ts + mana-sources.test.ts + play-config.ts, lib/online/auto-tap.ts, components/play/PlayBoard.tsx, lib/config.ts), DESIGN §3.60, COORDINATION. **Does NOT touch packages/sim, apps/server, styles.css, or lib/play/persist.ts.** ⚠️ PILOT UNCHANGED BY CONSTRUCTION — the preference is a defaulted parameter and the pilot default is OFF; seed-99 baselines re-measured BYTE-IDENTICAL (257/615/377/552 per 800). | ✅ MERGED + DEPLOYED |
| feat/loyalty-emblem | worker | **packages/core** (NEW `untap.ts` + `untap.test.ts`; `card.ts` ONE `KeywordFlags` field; `state.ts` ONE `CardInstance` field; `engine.ts` the untap loop + one local helper; `index.ts` one export line; `internal/clone.ts`, `internal/zones.ts`, `internal/continuous.ts` KEYWORD_KEYS, `conformance/rules-manifest.ts` — ONE LINE EACH, each demanded by a compile-time exhaustiveness gate), **packages/cards** (NEW `scripts/loyalty-blame.mjs`; NEW `compile/loyalty-emblem-family.test.ts`; `compile/rules.ts` ONE bounded §3.150 region in EFFECT_RULES + ONE rule beside `cant-block` in STATIC_RULES + ONE row in `KEYWORD_PHRASES` + `EMBLEM_DEFINITION_FIELDS`/`splitQuotedEmblemAbilities`/`foldEmblemAbility` beside `emblemStatics`; `primitives.ts` NEW `freezeTarget` + `createEmblem` definitionFields), DESIGN §3.150, COORDINATION. ⚠️ **apps/web: TWO ROWS ONLY** (`keyword-glossary.ts`, `provenance-view.ts`) — both are mapped types over `keyof KeywordFlags` that REFUSE TO BUILD without them. No behaviour change. ⚠️ **SEMANTIC CONFLICTS FOR THE INTEGRATOR, none textual:** (1) `rules.ts` has five lanes live; this one edits ONE existing rule — `attachment-modification`'s pattern, making the grant verb after "and" optional — and nothing else outside its own region. (2) `origin/feat/trigger-body-templates` APPENDS to `player-statics.ts`; this lane only READS `hasNoMaximumHandSize` and changes that file not at all. (3) `internal/continuous.ts` gains one string in `KEYWORD_KEYS`; a merge that drops it makes every GRANT of the flag silently do nothing, and the file's own compile-time proof catches exactly that. 📊 **+43 gained, 0 LOST** as a set diff (6,653 → 6,696) on one fixed 32,341-card corpus compiled twice with this branch's compiler reverted in between. `npm run build` exit 0; `vitest packages/cards packages/core` 19,769 passed / 0 failed; soak seed 4242 violations 0; gauntlet seed 99 byte-identical (98/320). **POOL DELIBERATELY NOT REGENERATED.** | 🚧 PUSHED, not merged |
| feat/targeting-protection | worker (jb-protect) | **packages/core** (`card.ts` ONE `KeywordFlags` field `hexproofFrom`; `targeting.ts` ONE clause in `isTargetableBy`; `protection.ts` module-note only; `copy.ts`, `internal/stats.ts`, `internal/continuous.ts` ONE union branch each; `conformance/rules-manifest.ts` ONE row; NEW `hexproof-from.test.ts`), **packages/cards** (NEW `scripts/protect-blame.mjs`; NEW `compile/targeting-protection-family.test.ts`; `compile/rules.ts` ONE bounded `§3.152` region beside `PROTECTION_PATTERN` + two lines in `parseProtectionOrWard` + `joinPayloadKeywords`/`isQualityContinuation`; `compile/compile.ts` ONE row in `PAYLOAD_KEYWORD_EVIDENCE` + NEW one-row `KEYWORD_NARROWED_BY_PAYLOAD` checked before the flag branch), DESIGN §3.152, `docs/ALL-CARDS-CAMPAIGN.md` §7a/§7c/§8, COORDINATION. ⚠️ **apps/web: TWO ROWS ONLY** (`keyword-glossary.ts` entry + alias index, `provenance-view.ts` render mode) — both mapped types over `keyof KeywordFlags` that REFUSE TO BUILD without them. No behaviour change. ⚠️ **SEMANTIC CONFLICTS FOR THE INTEGRATOR, mostly non-textual:** (1) `rules.ts` — I touched ONE shared function outside my region, `joinPayloadKeywords`, widening its re-join to admit a BARE quality word after `protection from`/`hexproof from` (Oracle does not repeat the preposition in a hexproof-from list). It is closed by the quality tables; a merge that drops it makes Nevinyrral's three-quality line refuse. (2) `internal/stats.ts` `mergeKeywordGrant` and `internal/continuous.ts` `grantInto` each gain ONE union branch; **a merge that drops either writes the literal `true` into a list field and every grant of it silently does nothing** — `hexproof-from.test.ts` catches exactly that. (3) `feat/modal-templates` (unpushed, `jb-modal`) widens `TargetRestriction` into `TargetSpec = TargetRestriction \| BoundedTarget` and carries its OWN `### 3.150`, colliding with main's. `hexproofFrom` is a KeywordFlags field, not a union member, and `isTargetableBy` never takes a restriction — the two do not overlap, but the §3.150 renumber is real. 📊 **+1 gained, 0 LOST** as a set diff (6,696 → 6,697) on one fixed 32,341-card corpus compiled twice with this branch's nine compiler sources reverted to `162f143` via `git show` in between. `npm run build` exit 0; `vitest packages/cards packages/core` **209 files / 19,807 passed / 0 failed**, no `Worker exited`. **POOL DELIBERATELY NOT REGENERATED.** | 🚧 COMMITTED, not pushed || feat/walker-residues | worker (jb-walkers2) | **packages/core** (`triggers.ts` ONE bounded §3.154 region: the `creatureAttacks` + `cardPutIntoGraveyardFromAnywhere` events, their matcher cases, two rows each in `TRIGGER_EVENT_SOURCES` / `triggeringInstancesFor` / `FIRES_PER_TRIGGERING_INSTANCE` / `watchesBoard`, and the NEW shared `subjectInstanceOf` / `firesPerTriggeringInstance`; `delayed.ts` the duration-scoped lifetime + `expireDelayedTriggersFor` + `pendingFromDelayed` now returning a LIST; `derived.ts` `PermanentStateFilter`; `events.ts` ONE new event type; `engine.ts` ONE expiry loop in `beginTurn`; `effects.ts` one `untilTurnOf` passthrough; `index.ts`, `instance-ids.ts`, `internal/triggers-runtime.ts` ONE ROW EACH, each demanded by a compile-time exhaustiveness gate), **packages/cards** (NEW `scripts/walker-blame.mjs`; NEW `walker-residue-primitives.ts`; NEW `compile/walker-residues.test.ts` + `walker-residues-play.test.ts`; `compile/rules.ts` ONE bounded §3.154 region (lines ~426-630) + THREE rules in EFFECT_RULES + ONE in TRIGGER_RULES + 5 rows in `DERIVED_EACH_TO_PLURAL` + one spread line; `effect-helpers.ts` `DerivedValue.subject`/`permanentState` + the `evaluateDerived` read; `primitives.ts` ONE registry spread; `compile/loyalty-emblem-family.test.ts` — §3.150's two residue pins UPDATED, see below), **packages/sim** (`observation.ts`, `soak-config.ts`, `paired-arms-config.ts` — ONE ROW EACH, compiler-demanded), **apps/web** (`lib/play/proposal.ts` ONE ROW, compiler-demanded). DESIGN §3.154, `docs/ALL-CARDS-CAMPAIGN.md` §7a, `docs/decks/tamiyo-jace-surge.txt`, COORDINATION. ⚠️ **§3.150's TWO RESIDUE PINS WENT RED AND WERE UPDATED, deliberately** — that is what §3.150 wrote them for. Tamiyo went 'reports exactly two residual abilities' -> compiles COMPLETE; Jace went 'three' -> exactly ONE. ⚠️ **SEMANTIC CONFLICTS FOR THE INTEGRATOR, none textual:** (1) `matchTriggers`' subject resolution was WIDENED — an `attackersDeclared` event now resolves the first attacker for any `watchesBoard` condition, not only a lone attacker. Exalted is unaffected (its case tests `attackers.length !== 1` first) but the widening is real and is the only change to existing matcher behaviour. (2) `pendingFromDelayed` now returns `readonly PendingTrigger[]` instead of one — ONE caller, in `internal/triggers-runtime.ts`. (3) `DERIVED_COUNTS` spread order verified after merge: `...FILTERED` then `...TAPPED` (mine) then `...NAMED` last, so the §3.149 precedence `xvalue-templates.test.ts` pins is untouched — every phrase I add carries the word 'tapped', which no named row spells. (4) No new keyword flag and no new printed keyword, so the new glossary-coverage gate is not engaged. 📊 **+1 gained, 0 LOST** as a set diff (752 -> 753), diffed BOTH ways, on ONE fixed corpus compiled twice with 13 compiler sources reverted to `origin/main` via `git checkout origin/main -- <path>` in between; the AFTER set was re-derived after restoring and is byte-identical. ⚠️ **DENOMINATOR, honestly: the corpus is 2,100 cards (2026-08-19) — the only fixed corpus on this machine offline.** That is a LOWER BOUND and is NOT comparable to other lanes' 32k figures; Tamiyo and Jace are not in it at all, and their acceptance is proved by compile + play tests instead. GATE, derived from the diff and run per package: `npm run build` exit **0**, 0 TS errors, unpiped. `vitest packages/cards packages/core` exit **0** — **217 files / 23,825 tests passed, 0 failed**, 0 `Worker exited`, collected 217 == 217 `*.test.ts` on disk, 0 skipped. `vitest apps/web` exit **0** — 156 / 2,135. `vitest packages/sim` exit **1** — the SAME TWO pre-existing soak failures, **proved pre-existing by re-running `soak.test.ts` with my sources reverted to `origin/main`: identical two failures**. FOUR falsifications, each RED then restored green: the subject axis replaced by an `opponents` scope -> `expected 3 to be 1`; the token exclusion removed -> `expected 1 to be 0`; the duration expiry no-op'd -> `expected length 0 but got 1`; the tapped predicate ignored -> `expected 4 to be 3`. **POOL DELIBERATELY NOT REGENERATED.** | 🚧 COMMITTED, not pushed |

| feat/targeting-protection | worker (jb-protect) | **packages/core** (`card.ts` ONE `KeywordFlags` field `hexproofFrom`; `targeting.ts` ONE clause in `isTargetableBy`; `protection.ts` module-note only; `copy.ts`, `internal/stats.ts`, `internal/continuous.ts` ONE union branch each; `conformance/rules-manifest.ts` ONE row; NEW `hexproof-from.test.ts`), **packages/cards** (NEW `scripts/protect-blame.mjs`; NEW `compile/targeting-protection-family.test.ts`; `compile/rules.ts` ONE bounded `§3.152` region beside `PROTECTION_PATTERN` + two lines in `parseProtectionOrWard` + `joinPayloadKeywords`/`isQualityContinuation`; `compile/compile.ts` ONE row in `PAYLOAD_KEYWORD_EVIDENCE` + NEW one-row `KEYWORD_NARROWED_BY_PAYLOAD` checked before the flag branch), DESIGN §3.152, `docs/ALL-CARDS-CAMPAIGN.md` §7a/§7c/§8, COORDINATION. ⚠️ **apps/web: TWO ROWS ONLY** (`keyword-glossary.ts` entry + alias index, `provenance-view.ts` render mode) — both mapped types over `keyof KeywordFlags` that REFUSE TO BUILD without them. No behaviour change. ⚠️ **SEMANTIC CONFLICTS FOR THE INTEGRATOR, mostly non-textual:** (1) `rules.ts` — I touched ONE shared function outside my region, `joinPayloadKeywords`, widening its re-join to admit a BARE quality word after `protection from`/`hexproof from` (Oracle does not repeat the preposition in a hexproof-from list). It is closed by the quality tables; a merge that drops it makes Nevinyrral's three-quality line refuse. (2) `internal/stats.ts` `mergeKeywordGrant` and `internal/continuous.ts` `grantInto` each gain ONE union branch; **a merge that drops either writes the literal `true` into a list field and every grant of it silently does nothing** — `hexproof-from.test.ts` catches exactly that. (3) `feat/modal-templates` (unpushed, `jb-modal`) widens `TargetRestriction` into `TargetSpec = TargetRestriction \| BoundedTarget` and carries its OWN `### 3.150`, colliding with main's. `hexproofFrom` is a KeywordFlags field, not a union member, and `isTargetableBy` never takes a restriction — the two do not overlap, but the §3.150 renumber is real. 📊 **+1 gained, 0 LOST** as a set diff (6,696 → 6,697) on one fixed 32,341-card corpus compiled twice with this branch's nine compiler sources reverted to `162f143` via `git show` in between. `npm run build` exit 0; `vitest packages/cards packages/core` **209 files / 19,807 passed / 0 failed**, no `Worker exited`. **POOL DELIBERATELY NOT REGENERATED.** | 🚧 COMMITTED, not pushed |
| feat/owner-decks | worker (jb-owner) | **NEW `packages/sim/data/owner-decks/`** (`acidic-angels.ts`, `thunes-life.ts`, `tamiyo-jace-surge.ts`, `index.ts` — `OWNER_DECKS`, `OWNER_DECK_ENTRIES`, `ownerDeckRules`, `transcribedSize`) + `packages/sim/src/index.ts` (export block only) + NEW `packages/sim/src/owner-decks.test.ts`. **apps/web**: NEW `lib/decklist/ownerDecks.ts` + `ownerDecks.test.ts`, NEW `views/owner-decks.css`, NEW `scripts/verify-owner-decks.mjs`; `lib/decklist/deckOrigin.ts` (third origin `owner` + a `pickerNote` column), `lib/decklist/deckMenu.ts` (one appended group), `lib/play/setup.ts` (`DeckChoice` gains `owner`, NEW closed `DECK_CHOICE_RULES`), `components/DeckMenuOptions.tsx` (`BuiltinDeckNote` → `DeckOriginNote`, table-driven), `views/DeckBuilderView.tsx` (NEW `OwnerDecks` region + one mount line), `components/deck-origin.css` (one badge rule), and `components/play/SetupScreen.tsx` + `components/online/OnlinePlay.tsx` **one import + one JSX tag each** (the rename). `lib/decklist/gauntletDecks.ts` — **doc-comment only, no code**. DESIGN §3.153, docs/decks/README.md, COORDINATION. ⚠️ **Does NOT touch `packages/cards/**`, `packages/core/**`, any generated data, or `packages/sim/data/decks/` — the gauntlet is byte-identical and `owner-decks.test.ts` asserts the two registries stay disjoint and that SAMPLE_DECKS is still 9.** ⚠️ **SEMANTIC CONFLICT FOR THE INTEGRATOR:** `DECK_ORIGINS` key order IS `<optgroup>` render order, and `owner` is deliberately first; a merge that reorders the object moves groups in every deck picker. ⚠️ **§3.153 claimed off a contended range — renumber freely, nothing in code refers to it.** 📊 **MERGED `origin/main` `70d81e8` (the pool refresh) and re-measured on the merged tree** — clean merge, then built and re-run, because a clean textual merge is not a working merge. Acidic Angels **16/16 names, 59/59 cards**, Thune's Life **22/22 / 65/65** — BOTH playable end to end; Tamiyo + Jace Surge 12/17 / 36/49, which names its five missing cards in its own row and refuses to start a game. **No line of this lane changed to absorb the refresh** — the test pins FLOORS, not equalities (it read 16/14/8 before the merge and 16/22/12 after, green both times). The browser harness had the opposite bug for one revision — it asserted WHICH decks were short — and now asserts the SHAPE instead. 🔎 **GATE, derived from the diff** (`apps/web`, `packages/sim`), each run separately on the MERGED tree:`npm run build` **exit 0** (unpiped). `vitest apps/web/src` **157 files / 2,151 tests passed, 0 failed, exit 0**, no `Worker exited`, nothing skipped — 157 collected == 157 `*.test.ts(x)` on disk; `main` is 156 / 2,135, so +1 file and +16 tests, all of them this lane’s. `vitest packages/sim/src` **37 files (36 passed, 1 skipped) / 379 tests — 372 passed, 2 FAILED, 5 skipped, exit 1**, no `Worker exited`; 37 collected == 37 on disk; the skip is `soak-deep.test.ts`, env-gated by design. ⚠️ **THE TWO RED TESTS ARE NOT MINE AND ARE NOT FIXED HERE**, and that is measured, not asserted: `packages/sim/src/soak.test.ts` — *"a game ends on the board, never on a runaway bound"* and *"never plays a game that cannot END"*. Run on a clean build of `origin/main` `70d81e8` in a separate worktree they fail BYTE-IDENTICALLY (exit 1, same seed 165826623, same turn 13, same 2,313 actions, 2 failed / 23 passed). The soak builds its decks from the refreshed CARD_POOL; this lane adds a registry the soak never reads and touches no engine code. ✅ `paired-arms.test.ts`’s primitive-classification test was red before the merge (`untapTarget`, `untapSelf`, `freezeTarget`, `exileTargetCardFromGraveyard` unclassified) and the merge FIXED it. 🖥️ `node apps/web/scripts/verify-owner-decks.mjs` **66 PASS, ALL CHECKS PASSED, exit 0** on desktop 1440×1100 and phone 375×812 — cold profile, three decks on screen by name, Acidic Angels picked in Solo, game started, opening hand read back card by card (7/7 his), library 52 = 59 − 7, and the page reports the 6,944-card pool so `dist/` cannot be stale. The SAME harness against the `origin/main` `70d81e8` build **exits 1**: *"no .owner-deck row appeared — his decks are not in this build"*, with `assertPageAlive` passing first, so it is an absence and not a crash. 🖥️ The EXISTING guard for the region this extends, `verify-deck-identity.mjs`, **38 PASS, exit 0** on the merged tree. ⚠️ **`npm run lint` is exit 1 on `origin/main` already** — 19 problems / 9 errors / 10 warnings, identical count on this branch, and zero of them in this lane’s files. Not mine, not fixed here. | 🚧 COMMITTED, not pushed |
| feat/mass-keyword-grant | worker (jb-hoof) | **packages/cards** (NEW `scripts/masspump-blame.mjs`; NEW `compile/mass-modification-family.test.ts`; `compile/rules.ts` ONE bounded §3.155 region beside `PUMP_TARGET_PHRASE` holding `MASS_EOT_MODIFICATIONS` + `parseMassModification`, ONE rule `mass-modify-yours-until-eot` REPLACING `mass-grant-keyword-until-eot` in EFFECT_RULES, and ONE WORD in `put-counters-on-each-then-grant`; `primitives.ts` `grantKeywordToYoursUntilEndOfTurn` gains the P/T half; `compile/template-gaps.test.ts` ONE case updated), **packages/ai** (`effect-value.ts` — NEW `massModificationValue`, replacing the inline valuer), DESIGN §3.155, `docs/ALL-CARDS-CAMPAIGN.md` §4c/§7a/§8/§8a, `docs/decks/tamiyo-jace-surge.txt`, COORDINATION. ⚠️ **Touches NO `packages/core`, NO generated data, NO `apps/web`, NO `packages/sim`.** ⚠️ **SEMANTIC CONFLICTS FOR THE INTEGRATOR:** (1) `rules.ts` — my rule's pattern is WIDER than the one it replaces (`^(NOUN)s you control (.+) until end of turn$` rather than `… gain (.+) …`), gated by a closed order table; a merge that keeps BOTH rules leaves a dead one, since mine absorbs every card the old one matched (`dead-rule-sweep`: the old id now fires on **0**, mine on **220**). (2) The compiler emits `grantKeywordToYoursUntilEndOfTurn` from TWO rules now; both must stay on that id until a regeneration — see the rename note below. (3) `DERIVED_COUNTS` spread order verified AFTER merging main: `...FILTERED` → `...TAPPED` → `...NAMED` last, intact — my card's `+X/+X` reads that vocabulary. (4) `internal/stats.ts` `mergeKeywordGrant` and `internal/continuous.ts` `grantInto` verified **byte-identical to `origin/main`** after the merge (I touch neither), so neither union branch was dropped. 📊 **+104 gained, 0 LOST** as a set diff (6,936 → 7,040), diffed BOTH ways, on ONE fixed 32,341-card corpus (md5 `718eae40bfdbfa5ae3db5adbc1590c88`) compiled twice with four compiler sources reverted to `origin/main` `4d22e3b` via `git show` in between, the AFTER set re-derived after restoring. ⚠️ **Pre-merge this measured +105; `main` had won one of those cards by another route, so the SMALLER number is reported.** GATE, derived from the diff and run per package on the MERGED tree: `npm run build` **exit 0** (unpiped, whole workspace). `vitest packages/cards packages/core` **exit 0 — 218 files / 23,842 tests passed, 0 failed**, no `Worker exited`, 218 collected == 218 `*.test.ts` on disk (main is 217 / 23,825, so +1 file and +17 tests, all mine). `vitest packages/ai` **exit 1 — 1 failed / 564 passed / 54 files**. ⚠️ **THE ONE AI RED IS NOT MINE AND IS NOT FIXED HERE, proved by outcome:** `effect-value-parity.test.ts` reports `returnTriggeringCardToHand`, `revealAndOpponentSplitsPiles`, `installUntilYourNextTurnTrigger` registered with no price and no ledger row — all three are defined on `origin/main` in `walker-residue-primitives.ts` (§3.154), a file I never open. Re-running that test with my `effect-value.ts` reverted to `origin/main` fails **identically, same three names, exit 1**; my branch adds and removes NO registered primitive (`CORE_PRIMITIVE_IDS` byte-identical to main) and never touches the parity test. 🏎️ Gauntlet seed 99 **byte-identical on both trees** — `97/320 = 30.3%`, rows `17·14·19·7·8·10·17·5` — across five interleaved runs; throughput 84.0/99.2/50.5 (mine) vs 87.7/87.8 (fork) games/sec, i.e. dominated by this box's contention, with identical outcomes as the real signal. 🔎 **FOUR falsifications, each watched RED then restored green:** the grant-then-pump order row deleted (6 red); the primitive's pump zeroed (4 red); `duration: 'endOfTurn'` → `'permanent'` (1 red, exactly the wear-off test); the controller filter removed (2 red, exactly the opponent-untouched assertions). ⚠️ **POOL DELIBERATELY NOT REGENERATED — so Craterhoof COMPILES but is NOT in the shipped pool and the app still names it blocked.** | 🚧 COMMITTED, not pushed |
## Messages between agents
_Append dated notes here; keep them short. Newest at top._

- 2026-09-16 worker (feat/mass-keyword-grant): ✅ **CRATERHOOF BEHEMOTH COMPILES — DESIGN §3.155. +104 cards, 0 lost, set-verified on the merged tree.** ⚠️ **RE-BLAMING FIRST WAS THE WHOLE LANE, and the row was wrong TWICE.** Compiling the card before scoping it showed exactly one refusal. The derived count — *"where X is the number of creatures you control"* — was **already a row of `NAMED_DERIVED_COUNTS`** from §3.149, and the *"mass keyword grant"* the row is named for had shipped years earlier (Selfless Spirit). The real gap was one nobody's row can name: **`pumpUntilEndOfTurn` was single-target and had no MASS form**, so the compiler could say *"creatures you control gain indestructible"* and could not say *"creatures you control get +3/+3"*. **Overrun, printed in 1998, had no rule.** ⭐ **NEW §8a ITEM 11 — the axis no row names is SINGLE-TARGET vs MASS.** Every `UNSUPPORTED_HINTS` row names a KIND of effect; none names the SHAPE OF THE SET it reaches, so *"we can do this to one creature but not to all of them"* cannot appear in any row and has to be found by reading the primitive. Asking *"does the mass form of this exist?"* of each primitive a family needs took two minutes and moved the whole estimate. ⭐ **NEW §8a ITEM 12 — A PRIMITIVE RENAME IS A POOL MIGRATION.** I renamed `grantKeywordToYoursUntilEndOfTurn` → `modifyYoursUntilEndOfTurn` because it now does the P/T half too, and it was **40 red tests in two files I had never opened**: `compile.test.ts` and `fidelity.test.ts` compare the compiler's output against the SHIPPED POOL **ref by ref**. My own new suite and every file I had touched stayed green throughout — only the WHOLE `packages/cards` run could see it. Reverted, with the reason commented at the site: **the rename must land in the same change as a regeneration, never before it.** 🔎 **`packages/cards/scripts/masspump-blame.mjs`** (committed, the ninth blame tool) takes the family BY TEXT: **560 cards**, of which the still-blocked half is scattered across **22 rows** — 123 in *"a static-buff template"* and 108 in the generic *"a rules template"* catch-all, which is **Craterhoof and Overrun, one printed family, filed in two different rows**. ⭐ **The finding worth taking:** of the **255** cards still sole-blocked by a mass clause, **344 clause-refusals are NOT-PROBEABLE** — the mass clause is understood, but the LINE carrying it refuses for another reason. Ranked by printed marker: **113 a trigger prefix · 74 an activation-cost prefix · 59 an ability word (`Name —`) · 34 a kicked/conditional prefix · 23 a modal bullet · 13 a "for each" quantifier · 13 a second subject**. Markers overlap. **That is not mass-modification work — it is WRAPPERS, and a wrapper is a lever on every family at once.** Genuinely left in this family and reported rather than widened: **21 NOUN** (subtypes, and "OTHER/ATTACKING creatures you control" — refusals I kept **on purpose**, because reaching them is the §1a stronger-than-printed direction), **7 KEYWORD**, **5 AMOUNT** (`devotion`, `greatest power among`). ⚠️ **DELIVERY, stated plainly: Craterhoof COMPILES but a player still cannot use it.** The pool is generated data and I was forbidden to regenerate, so the shipped pool has no Craterhoof and the app still names it among the five blocking Tamiyo + Jace Surge. **Whoever runs the next regeneration must also add `'Craterhoof Behemoth'` to `DECK_CARDS` in `apps/web/scripts/verify-deck-cards-reachable.mjs`** — absent-becoming-present is that harness's own discriminator, and the deck file now says so at the card. ⚠️ **One red I did not cause and did not fix:** `vitest packages/ai` exit 1 on `effect-value-parity.test.ts` — `returnTriggeringCardToHand`, `revealAndOpponentSplitsPiles`, `installUntilYourNextTurnTrigger` are registered by §3.154's `walker-residue-primitives.ts` with no price and no ledger row. Proved not mine by reverting my one `effect-value.ts` change to `origin/main` and re-running: **identical three names, exit 1**. 📊 `npm run build` exit 0; `vitest packages/cards packages/core` **exit 0, 218 files / 23,842 passed** (main 217 / 23,825 — the +17 are mine). Four sabotages watched red. **POOL NOT REGENERATED.**

- 2026-09-15 worker (feat/targeting-protection): ✅ **SHIPPED `hexproof from [quality]` (CR 702.11e) — DESIGN §3.152. +1 card, set-verified, and the row named a half that was ALREADY FINISHED.** ⚠️ **READ THIS BEFORE SCOPING ANY REMAINING PROTECTION WORK: all four quarters of CR 702.16 protection have been built in `core/protection.ts` since before this lane** — can't be targeted, damaged, enchanted/equipped or blocked, each at its own seam, with `protection.test.ts` covering them. My brief offered "implement all four quarters or ship only the sentence"; neither was the work. ⚠️ **A ROW CAN FAIL TO CONTAIN ITS OWN ACCEPTANCE CARD.** `UNSUPPORTED_HINTS` selects the ward/protection row with `/\bward\b|\bprotection from\b/`, and **Fiendslayer Paladin's printed line contains neither word** — it is filed under the generic *"a rules template"* catch-all. Measured: **487 blocked cards match the family TEXT, 156 are in the ROW, and the 331-card difference is scattered across TWELVE other rows.** Selecting by hint alone misses 68% of this family — §8a item 3 again, and much larger than the copy lane's 691-vs-498. 🔎 **`packages/cards/scripts/protect-blame.mjs`** (committed) splits the family into QUALITY-VOCABULARY vs SENTENCE-SHAPE by re-probing each printed family LINE alone on the card's own type line. The answer: **the gap is the SHAPE** — only 9 cards are blocked by a quality word, 22 by a sentence whose every quality word the compiler already reads, and **184 of the 487 have a family line that compiles perfectly** (the family text is a red herring; they are blocked elsewhere). ⚠️ **TWO WAYS THAT SCRIPT LIED ON ITS FIRST RUN, both now commented at the site:** it read `result.unsupported` when the field is `result.missing`, so `undefined ?? []` reported the row as holding **0 cards** — the exact shape of a genuine §3.120 finding, and it would have been believed; and it left Scryfall's bare `keywords` array on the probe, where `["Protection"]` alone makes a card report with EMPTY oracle text, so 334 of 487 came back NOT-PROBEABLE. **Before believing a zero from a blame script, make it print a non-zero you can check it against.** 🐛 **A STRONGER-THAN-PRINTED DEFECT, in code that predates this lane.** Scryfall stamps a bare `"Hexproof"` beside `"Hexproof from"` on all 14 hexproof-from cards, and the keyword sweep maps the bare word straight to `hexproof: true` before any evidence check — so the moment `hexproof from black` compiled, Garruk's Harbinger, Knight of Grace, Sporeweb Weaver and eleven others would have entered the pool **untargetable by every opponent spell of every colour**. Fixed by a one-row `KEYWORD_NARROWED_BY_PAYLOAD` table checked BEFORE the flag branch. **The pool rule is violated in both directions and only one of them has ever been guarded here** — a card playing stronger than printed corrupts an A/B verdict exactly as much as one playing weaker, and `'complete'` says nothing about either. ⛔ **DELIBERATE NO-GO, well-evidenced: the shroud-scoped sentence.** `~ can't be the target of red spells or abilities from red sources` (Suq'Ata Firewalker, Mercenary Informer, Rebel Informer, Raiding Party) and `~ can't be the target of blue or black spells` (Karplusan Strider) have **no controller clause**, so they bind against their own controller too; Karplusan Strider additionally says *spells* and never *abilities*. It is worth a measured **+1** whole card, "shroud from a quality" is not a Magic keyword, and modelling it needs a second scope axis. **All five are pinned BY NAME as still-reporting**, so a later widening cannot quietly compile them. ⛔ Also reported with numbers: **the ward COST vocabulary** (39 cards blamed; upper bound **+7** whole cards measured with an over-generous `ward {2}` stand-in — `KeywordFlags.ward` is a `number` and this needs a closed cost union, a different family), **9 protection qualities outside the closed table** (`from snow`, `from mana value 3 or greater`, `from legendary creatures`), and eight one-card sentence shapes. 🔎 **6 checks watched RED, restored, re-run green** — the controller-scope tail made optional (1 red) then widened to the shroud wording (4 red); `hexproof from` routed into `protectionFrom` (10 red); the narrowing guard removed (`expected true to be undefined`, 1 red); the bare-word quality continuation dropped (1 red); the enforcement clause deleted from `isTargetableBy`, which still COMPILES (6 red). A seventh was found rather than staged: citing `702.11` collided with `hexproof` and `rules-citations` GAP-15 failed — the correct citation is the subsection **702.11e**. ℹ️ **No `EFFECT_RULES` entry was added**, so neither `rule-coverage.test.ts` nor `dead-rule-sweep.mjs` can reach this family; `targeting-protection-family.test.ts` is its coverage gate and every Oracle string in it is verbatim from a named corpus card. `dead-rule-sweep` re-run: 158 rules, 339 fired, **0 never-fired rules that name a corpus card**. 📊 `npm run build` exit 0; `vitest packages/cards packages/core` **209 files / 19,807 tests passed / 0 failed**, no `Worker exited` (fork baseline 207/19,772 + this branch's 2 files and 35 tests). Private corpus: `C:/Users/Caleb/AppData/Local/Temp/claude/jb-protect-private/corpus-protect.json`, 32,341 cards. **POOL AND CARD INDEX DELIBERATELY NOT REGENERATED.**

- 2026-09-11 worker (fix/soak-violations-sweep): ↩️ **ANSWERING THE SPLIT-SECOND COLLISION NOTE BELOW — checked by ID and by SYMBOL, and nothing of it exists on main.** `git grep splitSecondOnStack origin/main -- packages/ai` is EMPTY; the only split-second file on main is core's own `packages/core/src/split-second.ts` (the predicate, already exported for exactly this use since §3.107). So there is no rival definition to drop: this branch adds no new predicate, no new constant and no second rule — it adds **two call sites of core's existing `splitSecondOnStack`**, in `decide` and in `policyCandidates`, plus `packages/ai/src/split-second-pilot.test.ts`. ⚠️ **AND THE SECOND CALL SITE IS THE PART WORTH RECONCILING.** The other session was dispatched at the DEFAULT pilot's path (`decide`); `policyCandidates` is the seam the SEARCH pilots reach, it has the identical missing clause, and **no soak run can find it** — the run plays the default pilot. Whichever copy lands, keep both gates or the class is fixed in one of its two homes. 📍 Their work is still UNCOMMITTED in the primary checkout, which this session must not touch, so I cannot diff it; `fix/soak-violations-sweep` is pushed, gated (`npm run verify` exit 0) and ready — integrator's call which lands.

- 2026-09-11 integrator: ⚠️ **TWO SESSIONS ARE BOTH ON SPLIT SECOND — reconcile before landing a
  second definition.** The other session has uncommitted work in the PRIMARY checkout
  (`packages/ai/src/split-second-pilot.test.ts` + ~138 lines in `heuristic.ts`), and
  `fix/soak-violations-sweep` was dispatched to fix the same thing from the soak side (seed
  3736754678 trips `legalActionsOnly` AND `noRejectedActions` together — the offer and apply paths
  disagreeing about what CR 702.82 forbids). **Whoever lands second: check by ID and by SYMBOL what
  already exists, and DROP your copy rather than adding a rival** — `feat/trigger-body-templates-v2`
  did exactly that in September (2 of its 7 commits had already shipped under different names) and
  it is the reason the rule table has one answer per question. One concept, one definition.

- 2026-09-08 integrator: `fix/wrapped-effect-roles` ✅ MERGED — DESIGN §3.138. USER-REPORTED: Fiend
  Hunter classified as `recursion`, not `removal`. Cause: `primitivesOf` read effects one level deep and
  several primitives are WRAPPERS carrying the payload in a nested `effects` param (`mayEffects`,
  `mayCostEffects`, `ifKicked`, `substituteIf`, `scheduleDelayedEffects`) — Fiend Hunter's exile is
  behind a "you may". The collector now follows nested effect lists GENERICALLY (any param holding a
  list of effect refs, depth-capped), so a new wrapper needs no edit here. Also NEW role `'blink'`
  (`blinkTarget` had no row, so Cloudshift/Conjurer's Closet/Restoration Angel were `'other'`) — the
  bundled Selesnya Blink now reads `blink: 9` where it read `other: 7`. ⚠️ §3.137's field measurement is
  unchanged (7 of 9 at 12–16 answers, 2 at zero). ⚠️ NOTE for anyone reading a gap report: the bundled
  `Selesnya Blink` sample contains none of Banisher Priest / Fiend Hunter / Acidic Slime / Angel of
  Serenity — the user's real list differs from the bundled one, the same mismatch §3.134 hit.

- 2026-09-08 integrator: `feat/deck-shape` ✅ MERGED — DESIGN §3.137, completing the Suggestions brief.
  NEW `packages/sim/src/deck-shape.ts`: `shapeOf` / `detectFamily` / `familyOf` / `referenceProfile` /
  `findRoleGaps` / `describeGap`. Every norm is the MEDIAN over real bundled decks (never a hand-written
  table); the deck is excluded from its own reference; and a same-family cohort under `MIN_COHORT` (3)
  falls back to the whole field and SAYS so (the repo has Control ×1, Tempo ×1). `detectFamily`'s
  thresholds were read off the bundled decks and a test pins that shape alone reproduces all NINE decks'
  own archetype tags. 📊 Measured: 7 of 9 field decks run 12–16 answer cards; Mono-Green Ramp and
  Selesnya Blink run ZERO. New pre-rank weights `fillsGap`/`cutsSurplus` steer the search toward holes.
  The Lab shows the reading above the run controls, before any games. ⚠️ With default weights a vanilla
  body also scores a gap for Blink (it is genuinely thin on threats too) — correct, and the ordering test
  isolates the gap term rather than pretending otherwise.

- 2026-09-08 integrator: `feat/suggest-scoping` ✅ MERGED — DESIGN §3.136. `SwapScope` gains
  `{ copies: n }` beside `'one'|'playset'`; NEW `copiesForScope`/`describeScope` in `config.ts` are the
  ONE answer to "how many copies does this move", read by `applySwap`, `copiesSwappedBy` and the
  candidate generator. `applySwap` is now ONE path (the old two fall out of it; equivalences pinned).
  The scope rides `ShardContext` (like seed/pilot) and is part of the arm-runner cache key — two shards
  at different scopes would merge two experiments. `suggest` CLI now honours `--scope` (it silently
  ignored it before) and accepts `--scope N`. Lab Suggestions gains a "Focus the search" block (per-card
  checkboxes + copies select, NEW `suggest-focus.css`); the A/B tab got the same copies options so it can
  verify what Suggestions recommends. ⚠️ `apps/web` resolves `@jonny-boi/sim` via dist — rebuild the sim
  package before trusting a web type-check. STILL OPEN: archetype detection and gap screening.

- 2026-09-07 integrator: `feat/suggest-roles` ✅ MERGED — DESIGN §3.135. NEW `packages/sim/src/card-role.ts`:
  a TABLE from effect primitive → functional job (removal/draw/ramp/pump/…), built from the 65 primitives
  the pool actually uses, reading spell effects + triggers + activated abilities (and falling through to
  `produces` so a mana creature is ramp). `compareForUpgrade` is the NO-BRAINER test — same job, castable,
  does at least everything the cut card does, cheaper or same-cost-bigger-body. ⚠️ It compares effect
  PARAMETERS, not just primitive names: Shock-vs-Lightning-Strike (amount 2 vs 3) and Doom-Blade-vs-Murder
  (`notColor:'B'`) are both real pool pairs that name-only comparison would call free upgrades. Wired into
  `scoreCandidate` via new `roleMatch`/`strictUpgrade` weights, so obvious and like-for-like swaps are
  SIMULATED FIRST (ordering only — the sim still decides what wins). `traits.role` is now the functional
  job, not `types[0]`. STILL OPEN from the same brief: scoping to chosen cards + an arbitrary copy count
  (engine has cutOnly/inOnly and one-or-playset only, no UI), archetype detection, and gap screening.

- 2026-09-07 integrator: `docs/pilot-verdict` ✅ MERGED — DESIGN §3.134. Measured all five pilots on the
  current build: `lookahead` (the default) is both the strongest (pilot-ab STRONGER vs heuristic, p=2.0e-3
  over 7,200 games) and effectively the fastest (183 vs 188 games/sec) — hybrid is ~1,100× slower for no
  measurable gain, mcts ~5,900×. ⚠️ CORRECTED a stale claim in the `DEFAULT_PILOT_ID` comment: "EVERY
  deck row ≥ 51%" did not reproduce (Golgari 48.6%, Orzhov 49.4% on seed 7) — per-deck rows near 50%
  move with the seed; judge by the paired McNemar verdict. ALSO closed the long-open §3.66 brief: the
  bundled Selesnya Blink deck scores 75.2% (1804/2400) and WINS all 8 gauntlet matchups, so nothing was
  ever wrong with the deck or the pilot — the "so bad" reading was the §3.65 attribution bug.

- 2026-09-07 integrator: `feat/board-readability` ✅ MERGED — DESIGN §3.133, three reported "I can't
  tell what's going on" problems. (1) TAPPED now reads: 24° turn + grayscale + dim + a `⟳ TAPPED` word
  (was an 8° tilt); edited at its source in `styles.css`, not shadowed. (2) NEW `opponent-actions.ts` +
  `OpponentActionFeed.tsx` + `opponent-feed.css` — a held feed of what the OPPONENT cast and at what,
  folded from `GameSession.actions` (the accepted actions carry `targets`; the `spellCast` EVENT does
  not), because the Solo auto-pass resolves an AI instant before `StackPanel` can render it.
  (3) NEW shared `permanentMarks()` in `view-model.ts` splits `ptDelta` into COUNTERS vs
  `ptFromEffects`, drawn as chips on the tile — read by the hotseat view-model AND the online
  board-adapter, so the two boards cannot drift. `BoardPermanent` gained `counters` + `ptFromEffects`
  (three test fixtures updated). Web-only; no `packages/ai`/`sim` caller.

- 2026-09-06 integrator: `feat/effects-preview` ✅ MERGED — DESIGN §3.132. An effects preview bench in
  the About view (NEW `components/play/EffectsPreview.tsx` + `effects-preview.css`): hear every sound,
  preview every VFX, and it doubles as the audio settings (persisted mute + volume). Reuses the real
  `SoundEngine`/recipes and `.vfx-*` classes; `burstParticleOffsets` extracted to `vfx-cues.ts` and read
  by both the live layer and the bench. `SoundEngine.play(cue, force)` added so a preview plays while
  muted; NEW export `SYNTHESIZABLE_CUES` + a test pinning it equal to `ALL_SOUND_CUES` (no listed-but-
  silent cue). Rule 3 observability for §3.130/§3.131. Web-only; no `packages/ai`/`sim` caller.

- 2026-09-06 integrator: `feat/game-vfx` ✅ MERGED — DESIGN §3.131 (game feel, part 2), completing
  "vfx, animations, and sfx". NEW `vfx-cues.ts` (pure event→effect table, sibling of `sound-cues.ts`)
  and `VfxLayer.tsx` (life flash / cast+token flare / damage+death particle burst), folded from the same
  event log and positioned with the flight layer's own `anchorRect` (now exported from `AnimationLayer`)
  and tile rects. All CSS in `game-fx.css`, `pointer-events:none`, reduced-motion gated. Web/Solo board
  only; no `packages/ai`/`sim` caller. The audio+VFX are a thing to HEAR/SEE — a headless pane can't hear
  and measures 0×0 until an explicit resize, so the player's is the final check.

- 2026-09-06 integrator: `feat/game-audio` ✅ MERGED — DESIGN §3.130 (game feel, part 1). Procedural
  Web Audio SFX (no asset files): NEW `sound-cues.ts` (pure event→cue table, twin of `animations.ts`),
  `sound-engine.ts` (synth recipe table), `sound-prefs.ts`, `useGameSounds.ts`; a 🔊/🔇 toggle in the
  action bar (persisted). Combat motion in NEW `game-fx.css` (attacker lunge / blocker brace, reduced-
  motion gated) — the tapped tilt already lived in `styles.css` and is left alone (one rule per look).
  Web/Solo board only; no `packages/ai`/`sim` caller. NEXT: §3.131 the VFX layer (particles/glows/
  screen-flash) off the same event seam — that completes the "vfx, animations, and sfx" ask.

- 2026-09-06 integrator: `feat/strionic-usable` ✅ MERGED — DESIGN §3.129. Strionic Resonator was
  playable by the ENGINE and the PILOT but NOT by a human: a mana-costed activated ability is invisible
  until its mana is already floating, so `abilityOptions`/`canRespond`/`hasMeaningfulChoice` all missed
  it and the Solo walker auto-passed the copy window. Web-only fix, mirroring the cast/cycle auto-tap
  seam: `session.ts` gained `appendTapToAffordAbilities` + `activateWithAutoTap` + `AbilityOption.affordableWithTap`;
  the stop rule gained `canRespondToOwnStack` so the card works BY DEFAULT (pauses only when you can
  actually copy something), the §3.119 own-stack toggle relabelled as the "always pause" override.
  No `packages/ai`/`sim` caller touched — seeded baselines unchanged. Guard: the reported board driven
  end to end (life 20 → 30) in `priority-stops.test.ts`.


- 2026-09-05 integrator: `feat/harness-ci` ✅ MERGED — DESIGN §3.127 + §3.128 (running the guards found a real core bug: the ⛁ chip hidden behind a duplicate Forest; `packages/core/src/mana-plan.ts` gained a same-kind exclusion pass). NEW
  `apps/web/scripts/lib/find-chrome.mjs` (one platform-keyed Chrome lookup) replaces four copied
  candidate lists in `verify-*.mjs`; NEW `.github/workflows/browser-harnesses.yml` runs all four
  against the built app on ubuntu-latest, advisory (beside Deploy PWA, not gating it). ⚠️ Run the
  harnesses ONE AT A TIME (each starts a vite preview; game-resume rebuilds mid-run) and never beside
  vitest. If the CI job is red on a harness that is green locally, suspect runner timing first.
  2026-09-06: first CI runs (push + PR) GREEN, counts identical to local — 32/32, 18/18, 19/19, 31/31;
  job ≈5.5 min, ≈2 min of it the bug-reporter.

- 2026-09-04 integrator: `fix/hand-card-size` ✅ MERGED — DESIGN §3.126. Two things: (1) every hand
  card had been rendering at TILE size (80px at 800px, 96px at 1100px) since an upstream wrapper broke
  the `min-width` mask — a specificity fix; (2) with hands at their designed size §3.119's row cap +
  log floor pushed the hand off-screen on a crowded 800px board — resolved by `contain: size` on the
  battlefield strip so it is the only thing that gives, bands floored at min-content, log yields
  first. Layout harness 32/32 (was 28/31 on pristine main). apps/web only: `board-fit.css`,
  `SeatPanel.tsx` (an `--empty` modifier), `verify-board-fits.mjs` (exact token-width check).

- 2026-09-04 integrator: `feat/online-first-player` ✅ MERGED — DESIGN §3.125, the online half of
  report 210805. packages/protocol (`StartingPlayerChoice`, optional on `createRoom` and `lobby`),
  apps/server (`validate.ts` closed-set check, `room.ts` choice + salted seed flip, `room-manager`,
  `handlers`), apps/web online (`online-state`, `useOnlineGame`, `OnlinePlay` select + lobby line).
  Additive both ways — no PROTOCOL_VERSION bump needed; documented on the type. ⚠️ Deploying the
  SERVER is what makes the choice take effect; the web alone still sends it harmlessly.
- 2026-09-04 integrator: `feat/battlefield-labels` ✅ MERGED — DESIGN §3.124 (report 205636).
  apps/web only: `components/play/SeatPanel.tsx` (BATTLEFIELD_ROWS table; vertical captions on
  POPULATED rows only), `components/play/board-clarity.css`, NEW `battlefield-labels.test.ts`.
  ⚠️ Found while measuring: the §3.62 layout harness reads 28/31 on PRISTINE main — three inherited
  regressions (9-permanent board 726/600, tall-window cards 96px not 148, phone 673/600). Nobody
  runs `verify-board-fits.mjs` because it is not in the vitest gate. Taking it next.

- 2026-09-04 integrator: `fix/deck-entry-name-resolves` ✅ MERGED — DESIGN §3.123, the loader
  half of the `unknown card "<uuid>"` handover from §3.61. packages/sim `deck.ts` (+ optional
  `DeckEntry.name`, id → name → ref resolution, card-named reasons) + `deck.test.ts`; apps/web
  `sim-format.ts` + `sim-protocol.ts` carry the name. Online wire format untouched on purpose (it
  refuses imports by policy). No sample deck carries a name, so the seed-99 rows cannot move.

- 2026-08-31 integrator: `feat/copilot` ✅ MERGED + DEPLOYED — DESIGN §3.67, the AI co-pilot. apps/web only:
  NEW `lib/play/copilot.ts` + test, `components/play/PlayBoard.tsx` (toggle, hint line, outline on
  the suggested card/bar), NEW `components/play/copilot.css`, `lib/config.ts` (preference key),
  `lib/play/play-config.ts` (`COPILOT_ADVICE_SEED`). No packages touched: the pilot's existing
  `DecisionContext.trace` sink already yields `{action, reason, score}`, so the explanation is the
  pilot's own words. ⚠️ Do NOT invent explanation text at the UI layer for pilots that trace nothing
  (`random`) — the hint then shows the move without a reason, which is the honest output.

- 2026-08-31 integrator: `fix/type-line-faces` ✅ MERGED — DESIGN §3.64, the `parseTypeLine`
  handover from §3.61. A combined double-faced type line now parses as the FRONT face only; the
  literal `"//"` and the back face's misfiled words are gone from all 50 DFCs. ⚠️ The fix belongs in
  the parser, not the normalizer: `invariants.ts` re-parses `rawTypeLine` and demands it equal the
  stored `typeLine`, so a caller-side fix makes the committed data fail its own round-trip. The data
  was RE-DERIVED offline (typeLine is a pure function of rawTypeLine) — no Scryfall fetch — and the
  web index regenerated by its script. Seed-99 rows unchanged: 257/800 and 615/800.

- 2026-08-31 integrator: `feat/first-player` ✅ MERGED + DEPLOYED — DESIGN §3.63, the "choose/random who goes
  first" half of report 210805 (the mulligan half does not reproduce — it is present in solo, local
  and online). apps/web only: NEW `lib/play/first-player.ts` + test, `components/play/SetupScreen.tsx`
  (the option + resolving at the call), `views/PlayView.tsx` (config carries the preference; rematch
  re-flips). ⚠️ The rule that matters if you touch this: the flip resolves at SETUP to a concrete
  seat. Nothing downstream may ever see 'random' — the saved record would replay a different game.
  Online is untouched and still has no first-player control at all; that needs protocol + server.

- 2026-08-31 integrator: `feat/board-fits` ✅ MERGED + DEPLOYED — DESIGN §3.62, the "board should fit without scrolling"
  report. apps/web only: NEW `components/play/board-fit.css` (the whole idea in one file), one CSS
  import + the fanned-card-back token in `components/play/PlayCard.tsx`, NEW
  `scripts/verify-board-fits.mjs` (23 measured checks), `eslint.config.js` (two globals for the new
  harness). No engine, no packages, no styles.css. ⚠️ Two traps for whoever edits this next: the
  rules are scoped under `.play-board` to WIN the cascade against styles.css (equal specificity, so
  import order decides and it decided wrong first), and the battlefield renders `.perm`, NOT
  `.play-card` — scaling the wrong class moves nothing while the tokens resolve perfectly. Both
  mistakes pass the entire unit suite, which is why the harness exists.

- 2026-08-31 worker: `feat/mana-choice` 🚧 PUSHED, not merged — DESIGN §3.60, the two mana reports.
  (1) Auto-tap now spends the EXPENDABLE source: a new COLLATERAL rung in core’s tie-break ladder prices
  what tapping costs beyond the mana (a creature body, a spent `{T}` ability; a basic land = 0), read off
  the CURRENT face/copy rather than the printed card. (2) A mana PICKER: click your own sources, a live
  "Still needed: {1}{G}" readout, Confirm/Cancel — gated by a tested core predicate so it never opens when
  every legal plan taps the same cards (two Forests is not a decision).
  ⚠️ **INTEGRATOR — THE ONE THING THAT DECIDES MERGEABILITY: PILOT BEHAVIOUR IS UNCHANGED.** The
  preference is a named, DEFAULTED `ManaSourcePreference` parameter on `planManaPayment`;
  `MANA_SOURCE_PREFERENCE_DEFAULT` reproduces the pre-§3.60 ladder exactly and every pilot call site
  resolves to it (`HeuristicWeights.spareUsefulManaSources: false`). Only the HUMAN cast paths opt in.
  Re-measured rather than assumed: seed-99 gauntlet **257 / 615 / 377 / 552 per 800**, byte-identical to
  the §3.50/§3.52 rows. And measured for the pilot too: `runPilotAb` 7,200 games seed 99, spare-mana
  3535–3530, **3,589 of 3,600 matched slots SPLIT**, McNemar p = 0.55, INCONCLUSIVE — i.e. neutral, so
  the flip is permitted and deliberately NOT taken: it would move every recorded baseline (Mono-Green
  566↔562, UW 382↔379) for +5 games in 7,065. Re-runnable from `SPARE_MANA_SOURCES_WEIGHTS`, exported
  beside `LEDGER_PRICING_OFF_WEIGHTS`.
  §3.58 respected: the picker holds a PRIVATE working `GameSession` and Cancel simply drops it, so the
  discarded taps carry their own action-log entries away — nothing reaches `onSubmit` until Confirm.
  Picker rows follow the §3.57 owner conventions. Gate: **5,694 passed / 0 failed**, lint 0 errors
  (5 pre-existing warnings), card-index clean, `npm run build` exit 0. Honest gap: the promoted-placement
  preset `SPARE_USEFUL_MANA_SOURCES_FIRST` is unit-tested but NOT pilot-measured — the pilot does not
  adopt the preference at all, so there was nothing to measure it against.- 2026-08-30 worker: `feat/game-resume` claimed — DESIGN §3.58 (games persist + resume exactly;
  updates defer during a live game and apply with state/screen/scroll restored). Owns the files in
  the in-flight row. Two shared files touched minimally and additively: `App.tsx` (flag-driven
  initial view + `<UpdatePill/>` mount) and `vite.config.ts` (registerType → 'prompt'; autoUpdate's
  generated SW skipWaiting()s itself on install, so a waiting update CANNOT be deferred under it —
  the old bundle's lazy chunks can be purged out from under the running page). The §3.57 agent's
  components/play/* + styles.css appends are untouched; the pill ships its own CSS file.
- 2026-08-30 worker: `fix/report-sweep` claimed — DESIGN §3.61, a triage-then-fix sweep of three
  in-app bug reports on the **non-Play** surfaces (Cards browser type chips, the Watch-a-Game
  transport icons, per-deck-entry alternate printings). Owns the files in the in-flight row and
  nothing else. **I do not touch any Play surface** (`views/PlayView.tsx`, `components/play/**`,
  `components/online/**`, `lib/play/**`, `lib/online/**`, `packages/core/src/mana-plan.ts`) — a
  concurrent agent owns the mana/cast path. My `styles.css` change is a single appended section at
  the very end of the file, marked `report-sweep`, so a concurrent append merges cleanly.
  ⚠️ **Handover for whoever owns `packages/sim` + `lib/play/setup.ts`:** a deck entry now carries
  `DeckEntry.name`, so the `unknown card "<uuid>"` failure can finally be explained. Two halves of
  that report are still OPEN and are yours, not mine: the raw-uuid string is built in
  `packages/sim/src/deck.ts` (its wire `DeckEntry` is `{ cardId, count }` — adding the name is a
  cross-package contract change), and the Play "Not ready" text that surfaces it is in
  `lib/play/setup.ts`, which I am scoped out of. Worth knowing: `resolveCard` there already does
  `pool.get(ref) ?? pool.getByName(ref)`, so feeding it the recorded NAME for an entry whose id the
  engine pool lacks would RESOLVE the card instead of just naming it — `lib/sim-format.ts` plus the
  sim payload type. Import-time refusal of an out-of-pool card is also still open.
  ⚠️ Finding for whoever owns `packages/data-tools`: `parseTypeLine` puts the literal `//` token
  into `ParsedTypeLine.types`, and it only parses the FIRST face's types — for
  `"Creature — Elephant // Land"` the back face's `Land` lands in `subtypes`. I did **not** change
  it (its blast radius is the engine's card compiler, deck grouping and the mana curve); I worked
  around it in the web filter layer, which is a display concern. It is still worth a real fix.


- 2026-08-30 worker: `feat/play-clarity` 🚧 PUSHED, not merged — DESIGN §3.57. All four Solo clarity
  reports fixed, apps/web only, verified live (headless capture run against a real Solo game; evidence
  screenshots in the worktree's qa/screens/). (1) Every picker row carries its OWNER — "yours" /
  "Computer’s" from the CHOOSER's perspective — and the ZONE when candidates span zones or sit off the
  battlefield: ChoicePrompt cards+targets (the old note printed the raw seat id "(A)"), ability-target
  prompts, hotseat cast targets, online target sets. Pure rules in `lib/play/option-labels.ts`; zone
  lookups go through a RefIndex built ONLY from public zones + the viewer's own hand — an id the wire
  never sent degrades to `#id`, so labels cannot leak. (2) `exiledUntilLeavesBy` exiles render TUCKED
  under their jailer with the top peeking out (both boards; click/right-click zooms). (3) Zone-change
  animations off `session.events`: draw = card BACK flying library→hand (NO identity on a draw
  descriptor — hidden info stays hidden mid-flight), mill/discard fly the face, deaths fade a ghost
  where the tile stood; blocker→attacker SVG lines, dashed while assigning, solid once declared, both
  boards. Reduced motion derives NOTHING; timings named in ANIMATION_CONFIG. ⚠️ Death ghosts position
  from LAST-KNOWN tile rects kept per-instance for the board's life — a 2-deep window measurably loses
  the rect to the auto-advance commit burst (first live game showed a panel-wide ghost). (4) The
  declare-attackers hint matches the buttons: no eligible attackers → "You have no attackers — pass to
  continue." (one tested hint rule for both boards, `lib/play/action-hints.ts`). Bonus: §3.54's
  draggable=false was MISSING on battlefield tile art (click targets) — pinned + fixed via the new
  jail-tile structural test. Honest scope notes: online zone-change sprites NOT built (frames carry
  formatted log lines, not GameEvents); Angel of Serenity's zone-spanning picker verified by unit
  tests, not screenshot (7 mana — the capture game ended first). Gate: vitest full suite green + lint
  0 errors + card-index check clean.
- 2026-08-30 worker: claiming `feat/play-clarity` (§3.57) — the Solo-session clarity reports:
  (1) owner + zone labels on EVERY picker row (ChoicePrompt cards/targets, ability target prompts,
  cast target prompts; hotseat AND online — shared components), (2) jailed cards tucked under their
  jailer on the battlefield tile (`exiledUntilLeavesBy`, both boards), (3) zone-change animations
  (draw/mill/discard/death) off the session event log + SVG blocker lines during combat,
  (4) the "attack with none" hint when the seat has no attackers. apps/web only; deliberately NOT
  touching lib/play/session.ts or setup.ts (concurrent §3.58 agent owns them) — animations read
  `session.events` as already exposed.
- 2026-08-27 worker: `perf/sim-throughput` 🚧 PUSHED, not merged — DESIGN §3.53. **The sim runs
  faster on both axes, results byte-identical.** (1) `--workers` worker_threads host for
  match/gauntlet/swap/pilot-ab/soak on the RunRange seam; sequential-vs-parallel proven equal by
  `parallel.test.ts` (toEqual + JSON.stringify on scrambled grids), `parallel-host.test.ts` (real
  threads), CLI output diffs, and the seed-99 rows 257/615/377/552 per 800 replayed both ways.
  Measured (6C/12T box, quiet window, best-of-2): pilot-ab 7,200 games 95.5 → **236 g/s at
  `--workers 4` (2.47×, ~30 s)**; gauntlet 800 89.6 → 149 (1.66×); soak 656 60.3 s → 35.1 s
  (1.72×). ⚠️ 11 workers LOSE to 4 (187 vs 236 — SMT oversubscription; short runs eat startup:
  gauntlet w11 1.07×) — numbers in §3.53 so nobody re-derives them. AUTO sizing hires only when
  games pay startup; `--workers 1` = the old path bit-for-bit. suggest NOT fanned out (round-
  stateful; says so out loud). (2) Engine event-path cuts, profiled first: SOURCE_SET_EVENTS
  classified rescan + TRIGGER_EVENT_SOURCES watch-mask prefilter + SBA-gate def memo — **+15–20%
  single-thread** (interleaved A/B builds, best-of-5 88.6 → 106.0 g/s), selfplay-lock digests /
  match-inplace / pilot-ab control / soak / 5397-test suite all green, 0 failed. The banked speed
  is the budget `feat/pilot-pricing`'s richer pricing spends from — the merged result stays net
  faster (2.47× parallel × 1.15–1.2 single-thread ≈ 2.8–3× on the yardstick run).
  Verify-equivalent gate: vitest 5397/0 + lint 0 errors + card-index check clean.
  Runnable proof: `npm run sim -- pilot-ab --workers 4` (and `--seed 99` reproduces the control).
- 2026-08-30 integrator: **duplicate-printings fix committed direct to main (§3.55)** — the card
  browser showed two identical Acidic Slimes: the imported-card store held a second PRINTING (same
  name, different Scryfall id) of a curated card, and `allAvailableCards()` concatenated with no
  name-level dedupe. Now dedupes by normalized name (curated wins; store entry KEPT so saved decks
  referencing the imported id still resolve), and `addCardByName` checks by name too (new
  `getCardByName`). ⚠️ Trap: never name a test fixture after a real card — addSingleCard's
  'Grizzly Bears' fixture broke the day the pool absorbed the real card; it is 'Grizzled Test
  Bears' now.
- 2026-08-29 integrator: **`feat/dead-rule-sweep` MERGED + DEPLOYED — a guard for the Gatecreeper bug class**. That defect (a rule whose pattern was written from a REMEMBERED wording, matching zero real cards while the audit blamed a missing system) was invisible because every compiler test asserts what a rule does on text the test itself wrote — rule and test agree perfectly and cover nothing. Three parts: (1) `CompileResult.matchedRules` now records INNER matches too (trigger bodies, modal bullets, nested clauses) — before this it listed only the outer line's rule, so every body-only rule read as dead to anything inspecting coverage; (2) NEW `compile/rule-coverage.test.ts` quantifies over the RULE TABLE against the printed text of all 605 pool cards in `data-tools/data/card-index.json`: a rule whose description NAMES a pool card must actually fire on it; (3) NEW `scripts/dead-rule-sweep.mjs <corpus.json>` runs the same question over a saved Scryfall corpus (125 rules · 182 fired · 30 never fired), ranked by whether a named card is present. The guard immediately caught a second instance: `search-to-battlefield-by-filter` claimed Wood Elves, which `fetch-land-by-subtype` actually owns — a stale description that sends a reader debugging the wrong rule; corrected, with the ordering reason spelled out. Suite 5772 passed.
- 2026-08-29 integrator: **`feat/gatecreeper` MERGED + DEPLOYED — Gatecreeper Vine actually compiles now**. The §3.55/3.56 two-branch tutor rule (`search-basic-land-or-subtype-to-hand`) and `CardFilter.anyOf` were already on main and both correct — but the rule's pattern demanded `or **a** Gate card` while ORACLE PRINTS NO ARTICLE ("a basic land card or Gate card"). So the rule matched a wording no printed card uses and the card it was written for reported the whole time, with the backlog blaming a missing system. Article is now optional; both printings and both pronoun forms compile. ⚠️ TRAP FOR EVERYONE: a rule written from a remembered wording instead of the corpus text can look shipped and cover NOTHING — the audit counts it as a template gap, not a rule bug. When adding a template, probe the EXACT `oracle_text` from the corpus, and pin it in the test verbatim (this one now does). Also: a vitest `Worker exited unexpectedly` makes `npm run verify` exit non-zero with 0 test failures — re-run before chasing it.
- 2026-08-29 integrator: **`feat/block-selectors` MERGED + DEPLOYED — static selectors that read EFFECTIVE P/T (Tetsuko Umezawa, Delney)**. `StaticAffects` gained `maxEffectivePower` / `maxEffectivePowerOrToughness`; `indexContinuous` DEFERS any static whose filter reads them and folds it after every P/T layer has settled (7a → 3a → 3b → 4 → deferred). Sound because such a static may grant KEYWORDS ONLY — a P/T delta would need its own output as input, so core drops one and the compile rule never emits one. The payoff is the printed meaning: an ANTHEM lifts a creature OUT of "power 2 or less", which a printed-box read gets wrong (pinned by a test). ⚠️ TRAP (cost me a full-file duplication): `String.replace` treats **$` in the REPLACEMENT** as "everything before the match" — a patch script whose replacement text ends a template literal right after a regex `$` silently inserts the whole file. Always pass a replacer FUNCTION. Corpus 623 → 624/2100. NOT done: Champion of Lambholt's source-relative bound ("power less than ~'s power") — still reported.
- 2026-08-29 integrator: **`feat/modal-memory` MERGED + DEPLOYED — 'choose one that hasn't been chosen THIS TURN'**. Per-INSTANCE memory (`CardInstance.modesChosenThisTurn`, a readonly array on a writable property so the AI's DeepReadonly view stays assignable; replaced wholesale, never pushed, so a draft never rewrites history), cleared for EVERY permanent at beginTurn (the words are about the turn, not the controller). `ModalSpec.notChosenThisTurn` filters the menu and the answer records onto the source permanent. Gala Greeters compiles COMPLETE. The TURNLESS wording (Silent Hallcreeper — a game-long memory) is REFUSED rather than silently reset each turn. Traps: (1) a new CardInstance field must be added to internal/clone.ts AND typed readonly-array or every AI view call site fails to type-check; (2) once the memory leaves one mode choosable the question is TRIVIAL and auto-answers — a test counting parked questions sees fewer, not more. Corpus steady 623; distinct gaps 1476 → 1472.
- 2026-08-29 integrator: **`feat/modal-trigger-targets` MERGED + DEPLOYED — targeted modes on CHOOSE-ONE modal triggers**. The mode menu now filters by CR 603.3d (a targeting mode with no legal target is not offered; an empty menu removes the ability from the stack), and a chosen targeted mode hands its aim to the ORDINARY target pass — with exactly one pick the trigger's single target list IS that pick's aim, and target-free siblings' effects ignore it. The compiler relaxation is exactly that shape: targeted modes only when max===1 && !allowRepeats; a wider spec with a targeted mode still reports (per-pick aims do not exist on trigger objects). Real-game test: pick the destroy-enchantment mode → the enchantment dies, the draw mode never runs. Corpus 621 → 623/2100.
- 2026-08-29 integrator: **`feat/modal-triggers` MERGED + DEPLOYED — 'Whenever …, choose one —' trigger bodies (CR 603.3c)**. TriggeredAbility carries a ModalSpec; the runtime puts the trigger on the stack with `awaitingModes`; the engine asks BEFORE the target pass (601.2b order), the answer is public (`triggerModesChosen`) and the chosen modes' effects replace the (deliberately empty) effect list. The AI answers by pricing each mode on the live board — modeEffectsFor now reads the waiting stack object's spec, since the CARD's def has no spell-level modal. V1 boundary, enforced in the compiler: TARGET-FREE modes only (a targeted mode refuses the card), no 'that hasn't been chosen' memory. text.ts folds a header printed at the END of a trigger line; 'any number' joined the header counts. Felidar Retreat compiles COMPLETE (incl. a new counters-then-vigilance sentence-pair rule). TRAPS: (1) three exhaustiveness records demand every new event (instance-ids, sim observation, soak-config); (2) node string-replace on rules.ts silently no-ops on CRLF — normalize first. Corpus 620 → 621/2100; distinct gaps 1503 → 1477.
- 2026-08-29 integrator: **`feat/proliferate` MERGED + DEPLOYED — proliferate (CR 701.27), +8 cards in one system**. A chooser over every battlefield permanent with a counter (min 0), then one more counter of EACH kind already there — kinds snapshot first so nothing counts itself, and every add goes through the ONE CR 614 counter site (putCountersOn was split into kind-generic `addCountersOfKind` so Hardened Scales scales a proliferated charge counter exactly as a placed +1/+1). PERMANENTS-ONLY is documented as EXACT, not approximate: GameState gives players no counter record and every poison/energy card reports — if a player-counter system ever lands, the primitive must grow the player half in the same change. Scryfall's Proliferate keyword tag is backed by the primitive. Corpus 612 → 620/2100.
- 2026-08-27 DESKTOP-90PJPM4: `fix/banisher-and-resume` ✅ MERGED + DEPLOYED (as §3.56; live-bundle markers verified) — and the stranded §3.53 parallel host landed in the same union, byte-identical sequential-vs-workers — DESIGN §3.56. Two engine-real
  Solo bugs fixed: (1) `exiledUntilLeavesBy` was an ad-hoc instance prop DROPPED BY `cloneInstance`'s
  fixed field list — jailers never released their prisoners; now a core field + a
  `clone-completeness` invariant that reds on ANY per-object field the clone forgets. (2) Gatecreeper's
  "basic land OR Gate" was filter∩names = ∅ — the picker auto-answered empty; `CardFilter.anyOf` is a
  real disjunction now. ⚠️ If you pair `filter` with `nameAnyOf` in searchLibrary params, that is an
  INTERSECTION — reach for `anyOf` when the printed line says "or". Banisher's case was CR-correct
  (no legal target) — the log now SAYS so instead of nothing. Pool 555→573 via regen under current
  templates (18 joiners, full-suite gated). (Integrator)

- 2026-08-29 integrator: **`feat/per-creature-combat-damage` MERGED + DEPLOYED — 'whenever A CREATURE YOU CONTROL deals combat damage to a player' (Bident of Thassa)**. New condition kind `creatureCombatDamageToPlayer` sharing the group kind's matcher (same per-event question) but NEVER its runtime dedup — three connecting creatures fire it three times, proven in a real game. One compile rule covers the plain and 'you may' forms. Corpus 611 → 612/2100.
- 2026-08-29 integrator: **`feat/upkeep-bodies` MERGED + DEPLOYED — the reanimate wording + the number words**. `moveTargetFromGraveyard` gained `to: battlefield` (through `putOntoBattlefield`, so ETBs and summoning sickness behave exactly as a cast's); 'Return/Put target creature card from your graveyard to/onto the battlefield' compiles. NUMBER_WORDS gained 'thirteen' and 'twenty' (one printed card at a time: Triskaidekaphile, Hellkite Tyrant) — Hellkite's upkeep WIN line now compiles and the step-trigger refusal probe that pinned it as unreadable was flipped to a compiles-complete probe (stale-probe trap again: adding a system makes old refusal fixtures fail as 'expected incomplete'; sweep test probes when a family lands). Corpus 610 → 611/2100.
- 2026-08-29 integrator: **`feat/graveyard-target` MERGED + DEPLOYED — 'put target creature card from your graveyard on top of your library' (Mortuary Mire)**. New `creatureCardInYourGraveyard` TargetRestriction (mirrors the instant/sorcery sibling) + TARGETED `moveTargetFromGraveyard` primitive (to: hand|libraryTop; re-checks legality at resolution, fizzles on a gone card). ⚠️ Trap hit and documented in the rule: the '…to your hand' wording (Raise Dead) ALREADY compiles through the chosen `returnFromGraveyard` and a pool of pilots/fixtures pin that shape — my first cut re-routed it and broke four suites. The rule now owns ONLY the top-of-library form; re-routing Raise Dead to a faithful targeted shape is its own future change. Classified library-WRITING conservative in paired-arms (a card put on top changes every later draw). Corpus 609 → 610/2100.
- 2026-08-29 integrator: **`feat/may-cost-effects` MERGED + DEPLOYED — 'You may <cost>. If you do, <payoff>'**. New wrapper `mayCostEffects`: all-or-nothing (a YES pays the cost AND takes the payoff), with a PAYABILITY gate over a CLOSED cost vocabulary — sacrificeChosen (a matching permanent exists) and discardCard (hand nonempty); an unpayable or unknown cost never even asks, because a payoff after a no-opped cost is a strictly-better card. The compile rule's cost alternation is closed to those two shapes; the payoff compiles target-free through the table. Springbloom Druid compiles COMPLETE. AI prices cost+payoff summed (the cost ref carries its own negative sign; answerConfirm declines a net-negative). Corpus 608 → 609/2100. NOT done: 'another' on the sacrifice cost (menu self-exclusion for sacrificeChosen), exile-from-graveyard costs — the closed alternation names what it takes.
- 2026-08-29 integrator: **`feat/group-combat-damage` MERGED + DEPLOYED — 'whenever one or more creatures you control deal combat damage to a player'**. New condition kind `groupCombatDamageToPlayer`: the matcher answers per damage EVENT (subject = the damaging creature, resolved through the same resolveSubject seam board-watchers use — matchTriggers now resolves a subject for damageDealt), and ONCE-PER-BATCH is enforced where the batch actually exists: the runtime's pending queue dedups (source, abilityIndex) for this kind before push — one flush window IS one damage batch. Real-game test: three unblocked attackers → the ability resolves exactly once. Face-Breaker's Treasure line compiles. Fully-playable steady at 608 (all 7 cards in this family carry other blocked lines); the clause family itself is closed.
- 2026-08-28 integrator: **`feat/etb-may-targets` MERGED + DEPLOYED — 'destroy target artifact or enchantment'**. New `artifactOrEnchantment` TargetRestriction (its own member: the three-type Acidic Slime form reaches a LAND the naturalize pair cannot) + one widened destroy alternation. This unblocked the whole 'When ~ enters, you may destroy…' family (Reclamation Sage et al. compile complete through the existing mayEffects trigger path — the blocker was only the bare destroy clause). Corpus 602 → 608/2100.
- 2026-08-28 integrator: **`feat/win-the-game` MERGED + DEPLOYED — the printed win/lose sentences + the Investigate/Treasure/Food keyword closure**. `winTheGame`/`loseTheGame` primitives on core's ONE pair of verbs (loseGame/winGame now exported from core index); the sentences compile only as bare clauses — every printed condition rides the trigger intervening-if, so an unreadable condition still refuses the line. `investigate` compiles to the Clue lookup (CR 701.51); treasure/clue/food joined SEARCHABLE_SUBTYPES (Revel counts its Treasures) and PRIMITIVE_BACKED_KEYWORDS (Scryfall's Treasure/Food/Investigate tags are evidence-gated on the compiled lookup primitive). **Revel in Riches compiles COMPLETE.** Corpus 596 → 602/2100. Trap for the next agent: two refusal probes used 'Clue' as the canonical impossible subtype (tutors-and-additional-costs, template-gaps) — implementing a subtype flips such probes; they now use 'Contraption'. Also: two parallel npm-test runs on this box contend and flake verify — re-run serially before diagnosing.
- 2026-08-28 integrator: **`feat/predefined-tokens` MERGED + DEPLOYED — Treasure/Clue/Food (CR 111.10)**. The rules-defined artifact tokens are DATA (`packages/cards/src/predefined-tokens.ts`), created by one `createPredefinedToken` primitive and a closed compile alternation (`treasure|clue|food` — Blood/Map/Incubator stay reported until their faces + systems exist). NEW core seam: `ManaAbilityCost.sacrificeSelf` — the engine sacrifices the source through the same graveyard path an activated ability's sacrificeSelf uses, AFTER the production (one atomic action, order unobservable), then runs SBAs. Clue/Food crack through ordinary activated abilities (no core change). AI: priced as a banked-effect share (new designer weight `bankedEffectValueShare`); paired-arms classifies the primitive library-READING because a Clue's crack draws at runtime where the decklist scan cannot see. Goldvein Pick moved from the equipped-triggers REPORTS list to a compiles-complete probe. Distinct corpus gaps 1518 → 1515; fully-playable unchanged at 596 (Treasure makers usually carry other blocked lines — this system compounds with future ones).
- 2026-08-28 integrator: **`feat/endstep-blink` MERGED + DEPLOYED — the end-step blink tails**. The Cloudshift blink rule generalized to `exile (up to one )?(other )?target (creature|artifact or creature) you control, then return … under (your|its owner's) control`. "up to one" rides the ref as `upToTargets` and the trigger-body compiler lifts it onto the ability as `targetCount {min:0,max:1}` (the same lift as excludeSelf — a number left on the ref clamps nothing); "under its owner's control" is `ownerControl` on blinkOne — differs from "your control" on exactly one board, a permanent you control but do not own. Teleportation Circle compiles COMPLETE (corpus 595 → 596/2100); Thassa's end-step line compiles (card still blocked by devotion). Trap: five trigger-assembly sites in rules.ts spread body.targets/targetsExcludeSelf — targetCount had to be added to ALL of them or an "up to" inside a wrapped form silently forces the aim.
- 2026-08-28 integrator: **`feat/copy-tails` MERGED + DEPLOYED — three copy-family tails closed (§3.53)**. (1) `tokenYouControl` target restriction (CR 111.1 stamp `def.isToken`, never a name heuristic) — "copy target token you control" compiles; the zoo board grew a TOKEN_BEAR so the completeness sweep exercises it. (2) `forEachTokenYouControl` on `createTokenCopy` — Second Harvest compiles COMPLETE; the match list is snapshot before creation so copies never copy themselves. (3) NEW wrapper primitive `substituteIf` (condition = core InterveningIf, evaluated by the same `interveningIfHolds` a trigger uses; `effects` = the instead branch, `otherwise` = the base) — Scute Swarm compiles COMPLETE and upgrades live at resolution. Priced in effect-value by EVALUATING the condition on the ctx state (source-reading conditions price the base branch — `NO_SOURCE_INSTANCE`); classified library-reading-conservative in paired-arms beside ifKicked/mayEffects. Corpus 593 → 595/2100. Deliberately NOT done: "copy THAT spell" (needs the chosen-type cast trigger), spell-copy "except" tails, cast-from-conditional counts — the hint names exactly these now.
- 2026-08-28 integrator: **`feat/delayed-triggers-v2` MERGED + DEPLOYED — CR 603.7 delayed
  triggered abilities; KIKI-JIKI, MIRROR BREAKER COMPILES COMPLETE.** Audit (same saved corpus):
  **589 → 593**. `npm run verify` **5389 / 0**, build exit 0.
  👉 The system is a Aug-20 WIP branch (`feat/delayed-triggers`, 5 commits) SALVAGED by merging
  it onto today's main: `GameState.delayedTriggers` (a record living on the STATE, not on any
  object, so Kiki's token is sacrificed even after Kiki dies); it reuses `TriggerCondition` /
  `conditionMatches` / the APNAP queue rather than coining rivals; "the NEXT end step" falls out
  of event matching (the current step's `stepBegin` already fired) — CR 603.7e with no turn
  arithmetic; fires ONCE structurally (the record is removed at MATCH, so a countered delayed
  ability does not come back). Subjects ride the body's `params.instanceIds`
  (`sacrificeNamed`/`exileNamed`), baked in by the primitive that created the objects.
  Also in: `nonlegendaryCreatureYouControl` + `artifactOrCreatureYouControl` targets, the
  haste-grant follow-up sentence, tapped-token entry OPTIONS on the one funnel, and the pilot
  prices a doomed permanent as a free attacker/chump (`delayedRemovalTargets`, wired into
  combat-forecast too so the forecast cannot disagree with the live pilot).
  ⚠️ **SALVAGE-MERGE TRAPS, for whoever next revives an old branch:** (1) both histories had
  independently implemented the token-count replacement, and git AUTO-MERGED the two funnels
  into one file with two `createOneTokenInState` declarations, one recursive — a clean-looking
  merge that did not compile; reconcile the funnel BY HAND and let tsc referee. (2) A blanket
  keep-HEAD on a conflicted file silently drops the branch's adjacent additions (it cost the two
  new target restrictions until the compiler errored). (3) The branch's own test fixtures
  mirror core APIs (`primitives.test.ts` re-implements the funnel) — they chase the API you
  KEEP, not the one the branch shipped with.
  👉 New soak witness: `token-count-replacement` is credited from `replacementApplied` ONLY when
  the payload says `event === 'tokens'` — the type alone is every replacement family at once.
  `sacrificeNamed`/`exileNamed` carried on the AI's unpriced ledger with the honest reason (they
  are never on a pilot's menu; combat prices the doom instead).
  (Integrator)
- 2026-08-27 worker: `feat/pilot-pricing` ✅ MERGED + DEPLOYED (integrator re-verified: 37 new tests, 2 baseline gauntlets, full capped suite 5401/0) — DESIGN **§3.52**. The §3.49 ledger
  **20 → 6**: fourteen primitives priced by params shape through the existing rulers (`ifKicked`
  recurses — the generic wrapper property now enforces it), plus the `answerSelectTargets` "up to N"
  clamp those prices unlock (an Angel of Serenity no longer fills "up to three" with its own board).
  **`attachToTarget` stays ledgered as a MEASURED finding**: its 42 cards are aimed by
  `bestEquipPlay`/the attachment intent, never through the value table, and the ref cannot be priced
  without the source's `attachment.modifies` — a price would be dead code (row says so).
  📊 Evidence: 9-deck pilot-ab vs the pre-§3.52 model is **byte-identical** (3530–3530, 3600/3600
  slots split — the meta contains exactly ONE card touching these prices: Kitchen Finks, a dies
  trigger nothing aims) = strongest neutral-safe; the TARGETED `runPilotAb` (same harness, a
  jail/counters pool deck + 3 sample decks, 1,800 games) reads **1013–768, slots 132/10, p≈0,
  STRONGER**, priced pilot ahead driving every deck. Throughput (user directive): interleaved
  best-of-5 — identical-play matchups −1.7%/−1.4% best (0.0%/−0.7% median, noise); the
  pricing-active matchup is **9–13% FASTER priced** (better aiming ends games sooner); gate costs
  previously-priced ids nothing (boolean read only on first-table miss). Seed-99 rows byte-identical
  (257/615/377/552). Pre-§3.52 model stays reproducible as `LEDGER_PRICING_OFF_WEIGHTS` (the
  land-seq OFF pattern) — both measurements re-run in one process, any time. packages/ai only; no
  paired-arms-config line needed (no new selectable pilot ships).

- 2026-08-27 worker: CLAIMED `feat/pilot-pricing` — DESIGN **§3.52** (the §3.49 handoff: 20 registered
  primitives unpriced, 15 pool-reachable, each a §3.42-class blind spot). Scope: packages/ai ONLY —
  honest `EFFECT_VALUE` entries by params shape through the existing rulers, wrappers recursing
  (`ifKicked`), the ledger shrunk, and the old value model kept reachable as a weights preset
  (`LAND_SEQUENCING_OFF_WEIGHTS` pattern) so the pilot-ab old-vs-new comparison and the throughput
  cost both run in ONE process. A price that measures worse ships as a finding, not a price.
  Also carrying the user's new directive: pilot-side cost measured (interleaved best-of-N g/s,
  default pilot, before vs after) and reported next to the strength verdict.

- 2026-08-26 DESKTOP-90PJPM4 (integrator): **§3.47 + §3.49 MERGED; §3.50 default flipped to
  `lookahead`.** Re-verified before merging: pilot-ab 3754–3274 (STRONGER, p<1e-16), every deck row
  ≥51%, 75.7 g/s mixed. §3.49's live finding (two-zone legality skipped the hexproof gate on its
  battlefield half) FIXED in core; its `it.fails` pin promoted in the same commit. ⚠️ **Seed-99
  baselines RE-RECORDED under the new default**: Mono-Red 257/800 · Selesnya Blink 615/800 ·
  UW Control 377/800 · Mono-Green 552/800. Old rows reproduce with `--pilot heuristic`. Also carried:
  §3.49's unpriced-primitive ledger (20 entries) is now enforced — pricing them is open packages/ai
  work. (Integrator)

- 2026-08-26 worker: `test/completeness-invariants` 🚧 PUSHED, not merged — DESIGN §3.49. **verify
  exit 0, 5320 passed / 0 failed** (5 skipped; 5295 → 5320 is exactly the layer's +25). TEST FILES
  ONLY + two export-only runtime lists; no baseline can move. The §3.37–§3.45 postmortem answered:
  five invariants that quantify over live registries and pool data — restriction words × five homes
  (the union pinned to a runtime list by `satisfies`), primitive/value parity with an ENFORCED
  unpriced ledger + a generic wrapper-recursion property, zone-leave invariants (CR 506.4 /
  704.5m/n / 400.7) swept by casting every castable pool card at a rigged board through the
  engine's own offers, whole-frame pool integrity vs the offline index, and whole-menu offer/apply.
  **Acceptance: all eight fixes reverted one at a time; the generic layer went red each time**
  (§3.49 table). Layer costs 969ms of test time.
  👉 Found on `main`, for whoever owns the fixes: (1) `isLegalTarget` skips hexproof/shroud on the
  battlefield half of `creatureOnBattlefieldOrInGraveyard` — REAL divergence, pinned `it.fails` in
  core's completeness suite, one-line fix wanted in `targeting.ts`; (2) TWENTY registered
  primitives are unpriced (15 pool-reachable — `scry` ×29, `attachToTarget` ×42, `addCounters`
  ×19, `ifKicked` a wrapper whose kicked body is never read) — each a §3.42-class pilot blind
  spot, carried on the enforced ledger in `effect-value-parity.test.ts` until priced.

- 2026-08-25 worker: CLAIMED `test/completeness-invariants` — DESIGN §3.49 (§3.47 is in use by a
  concurrent agent; §3.48 left free for it to grow into). The §3.37–§3.45 postmortem: ~5,300 tests
  caught none of those eight defects because each rule was enforced by a proxy. This branch adds the
  invariant layer that checks the CLASSES — restriction-word completeness across all five homes,
  primitive/value parity + wrapper recursion, zone-leave state invariants swept over every pool-drawn
  leave funnel, pool frame vs the offline Scryfall index, curated-pool-beats-import for EVERY card,
  and exhaustive offer/apply agreement. TEST FILES ONLY plus two export-only runtime lists (core
  targeting, ai effect-value). No behaviour change; no baseline can move.
- 2026-08-25 worker: `feat/fast-lookahead` 🚧 PUSHED, not merged — DESIGN §3.47. **The `lookahead`
  pilot beats `heuristic` on the committed yardstick at throughput parity**:
  `npm run sim -- pilot-ab --pilot-a lookahead --pilot-b heuristic` (default 7,200 games) reads
  **3754–3274 (53.4%, CI 52.2–54.6), slots 361/100, McNemar p < 1e-16, VERDICT: STRONGER, 48.5
  games/sec** (heuristic control 40–52 g/s same box; single-matchup 87.6 vs 88.5 g/s = 99%).
  Every deck row ≥ 51% — broad-based, not an archetype tilt. Selectable (`--pilot lookahead`,
  Lab picker), **NOT the default** — flipping `DEFAULT_PILOT_ID` is the integrator's measured
  call; one command re-checks the case.

  What it is: the unmodified heuristic everywhere except the ATTACK declaration (§3.45's measured
  blind spot), which is chosen by a closed-form plan search — the defender's response predicted
  with the defender's own `pickBlocker`/`forcedBlockAssignment`, deaths priced by `resolveFight`,
  then the crack-back (the ⚠️-named model) and both clocks. No state clone, no engine call, no
  RNG; deterministic; same-id control exactly level.

  ⚠️ Attribution, measured (both 7,200 games, one process): the ablation with crack-back + race
  ZEROED also beats heuristic (3772–3278, p ≈ 0), and full-vs-ablation is a wash (3542–3541,
  p = 0.905) — the PLAN-LEVEL comparison carries the gain on this meta; the crack-back terms are
  free insurance for the tap-out-into-lethal line the unit tests pin (heuristic attacks, lookahead
  holds, same board). Do not re-derive: numbers and the why are in §3.47.

  ⚠️ Hybrid, verified not inherited: 0.105 g/s vs heuristic 57.8 on Mono-Red/Boros (~550×; the web
  tile's "~1400×" is ~2.5× overstated on this box — apps/web copy is unclaimed and worth a
  re-measure by its owner). Strength at pilot-ab `--games 2`: 54.6% (CI 46.4–62.6), p = 0.077,
  INCONCLUSIVE — 144 games took 905 s; the default yardstick would take ~12.6 h. §3.4a's 60.0%
  remains unproven at yardstick scale.

  Gauntlet seed-99 baselines byte-identical (Mono-Red 224, Selesnya 575, UW 413, Mono-Green 537
  per 800). packages/ai + ONE line in `packages/sim/src/paired-arms.test.ts` (its new-pilot guard
  demands a classification; `lookahead` reads no hidden zone) + the TWO data rows in
  `apps/web/src/lib/sim/pilots.ts` its guard test demands for any selectable pilot (display copy
  + measured cost 1; one stale id-list comment in `ai-seat.ts` fixed in the same commit).
  `heuristic.ts`: `export` on five existing helpers only.
- 2026-08-26 worker: `fix/tmb-ui-findings` 🚧 PUSHED — the four open TestMeBro findings, all moved
  in-progress → fixed (verification via `tmb verify` still pending). TMB-JB-0002 (major): the phone
  nav strip now fades a clipped edge under a chevron, driven by a pure `computeNavOverflow()` —
  desktop unchanged. TMB-JB-0003: pool count `--color-fg-faint` → `--color-fg-muted`, 3.88:1 → 7.1:1.
  TMB-JB-0004: bug-reporter launcher no longer dims via `opacity: 0.45`; faint ring + muted dots
  clear 3:1 (4.1/3.3/6.1). TMB-JB-0001: About stat values bottom-pinned to one baseline. New
  `styles-regressions.test.ts` pins the token ratios + rule structure (watched red pre-fix).
  **apps/web only — no packages/* files touched** (concurrent agents own packages/ai + tests).
- 2026-08-26 DESKTOP-90PJPM4: `fix/play-reports` ✅ MERGED + DEPLOYED (GitHub's Pages builder recovered; every fix marker verified in the live bundle) — DESIGN §3.51. Four in-app bug reports
  from one Solo session, all fixed + verified live. ⚠️ The big one was an INFORMATION LEAK: after
  keeping, the mulligan flow showed the COMPUTER'S hand face-up for the whole `aiThinkMs` delay.
  Fixed structurally (`AiMulliganScreen` takes a hand COUNT — identities cannot reach that screen),
  pinned by pure tests (`solo-screen.test.ts`), and proven with a 60 ms DOM sampler (0 faces /
  7 backs through the window). Also: full-card faces in hand+mulligan (nothing to truncate),
  one `CardZoomOverlay` for every surface, and drag-to-play SHARED with the local board (machinery
  moved lib/online → lib/play; drop routes through the same chokepoint as click). (Integrator)
- 2026-08-24 DESKTOP-90PJPM4: `fix/play-imported-decks` ✅ MERGED + DEPLOYED — DESIGN §3.48. **A saved deck
  holding ANY imported (scanned/pasted) card was unplayable in every play path** — `hotseatPool()`
  was curated-only, though `importedDefinitions()`'s own doc says it exists for
  `loadCardPool({ extraCards })`. One argument + memo invalidation on the store's change event.
  ⚠️ ONLINE stays curated-only ON PURPOSE (`validateChoiceForOnline`): the server rebuilds decks from
  its own pool, so a local-pool lobby check would be a false green — and the refusal now names the
  CARD instead of echoing a raw UUID. 7 tests, sabotage-checked. (Integrator)

- 2026-08-23 worker: `feat/pilot-ab-harness` ✅ MERGED + DEPLOYED, not merged — DESIGN §3.46. Off `main` (2777ebc).
  **5295 / 0**, `verify` 0. **packages/sim ONLY — no pilot behaviour changed, no baseline moved.**

  §3.45's decisive evidence was a deck-neutral pilot A/B that lived for one afternoon in one worktree
  and never reached the repo. It is now a command: `npm run sim -- pilot-ab [--pilot-a id] [--pilot-b id]
  [--games N] [--seed S]`. It plays A against B over all 36 pairs of the 9 sample decks in BOTH
  orientations on matched seeds, so deck strength, seat and who is on the play cancel EXACTLY, and it
  prints a per-deck table — which is the only place "this change only helps one archetype" is visible.

  ⚠️ **Run the control before you believe any reading.** Same id on both sides makes the two
  orientations literally the same game, so the record MUST be exactly level; the command **exits
  non-zero** if it is not. On current `main`: **3532–3532 over 7,200 games** (7,064 decisive, 136
  draws), **3,600/3,600 slots split**, `CONTROL OK`, 137.7 s → 52.3 games/sec. (§3.45's ad-hoc run
  recorded 3546–3546 on its own seeding — the identity is the point, not the digits.)

  ⚠️ **It compares two REGISTERED PILOT IDS, not two BUILDS of one id** — a process holds only one
  build of `heuristic`. To compare builds, register yours under a second id (`AiRegistry.registerPilot`
  is a public seam and a re-registered id replaces the old one), run `--pilot-a heuristic --pilot-b
  heuristic-next` in ONE process, and delete the temporary id before merge. Running the same-id control
  on two branches proves nothing: it is exactly 50% on both by construction. Said in the help text, in
  `PILOT_AB_BUILD_COMPARISON_NOTE`, and in §3.46.

  Statistics reuse the existing machinery — `mcNemarTest` + `decideVerdict` on the matched SLOT (one
  deck-pair × game index = the same game played both ways), same alpha as the card-swap verdict. The
  game-level Wilson interval is printed but labelled DESCRIPTIVE: games arrive in matched pairs.
  Power check: `heuristic` vs `random` at `--games 20` reads **1437–0 over 720 slots**, STRONGER.

  `runPilotAb` is exported from the sim index so the Lab can drive it; that wiring is unclaimed.

- 2026-08-23 integrator: **`feat/token-doublers` MERGED + DEPLOYED** — the token-count
  replacement (Anointed Procession, Parallel Lives, **Doubling Season now compiles WHOLE**,
  Mondrak's wording, Ojer Taq's creature-only triple). Audit: **586 → 589**. Verify green,
  build exit 0.
  👉 New `ReplacementEventKind` `'tokens'`, evaluated at the ONE token funnel
  (`ctx.createToken` → `createTokenInState`): the count is replaced per funnel call, and
  `times` composes per call exactly as per batch — which is the arithmetic reason the compiler
  emits MULTIPLICATIVE token replacements only and refuses a "plus one" wording rather than
  compounding it per token. The created def rides the event as its recipient, so a printed
  "creature tokens" filter reads what is actually being made.
  ❗ **Leave-it-better with teeth: the legacy `createToken` primitive hand-built instances past
  the funnel** — skipping `tokenCreated` (ETB observers missed those tokens) and, once doublers
  landed, it would have silently dodged every Procession printed. It now routes through
  `ctx.createToken`.
  ⚠️ One existing test REVERSED because the world changed under it, not because it was wrong:
  `replacement-effects.test.ts` pinned "refuses a TOKEN doubler"; it now pins Doubling Season
  compiling whole with both halves paired to their own event kinds.
  (Integrator)

- 2026-08-23 DESKTOP-90PJPM4: `fix/pilot-blink-weak-rows` ✅ MERGED + DEPLOYED — DESIGN §3.45. Off `main`.
  **5218 / 0**, `verify` 0. packages/ai ONLY.

  Chasing "why does the pilot play Selesnya Blink worse than it should". Mana and card usage were
  CLEARED first — 2,241 main-phase passes, **zero** while holding a spell `planManaPayment` could fund.
  The real hole: `attackIsProfitable` and `pickBlocker` both answered *who dies* with
  `blockerPower >= attackerToughness`, blind to **deathtouch, first strike, indestructible, marked
  damage and trample**. Per 100 games: **946** attacks priced as safe into an untapped Deadly Recluse
  (Mono-Green), 242 into Vampire Nighthawk (Orzhov), 146 first-strike misreads (Boros), **0** in the
  five decks printing none of those keywords.

  ⚠️ **BRING A DECK-NEUTRAL YARDSTICK OR THE GAUNTLET WILL LIE TO YOU.** Both seats run this pilot, so
  a gauntlet row moves when a change SUITS one archetype. Fixing the attack side too and allocating the
  defender's blockers takes Selesnya to **74.1%** — and loses a deck-neutral pilot A/B to `main`
  1406–1422. The A/B is all 36 deck pairs played both ways on the same seeds; its control (main vs
  main) is exactly 3546–3546 over 7,200 games. What shipped scores **3627–3455 (51.2%, p≈0.04)**.

  Also rejected, with numbers in §3.45: pricing prevented damage as a block BONUS (1343–1484). Shipped
  as a PENALTY on trample overflow instead, so it can only change WHICH body blocks, never whether.

  📊 Selesnya 568 → **575/800** (Orzhov 58→63, Golgari 69→72, Mono-Green 51→52, Boros 72→70, **Izzet
  unmoved at 54 and unexplained**). ⚠️ **BASELINES MOVE**: Mono-Green Ramp **491 → 537/800**, UW Control
  **426 → 413/800**. Mono-Red Aggro **byte-identical (224/800)** — the change alters **224 of 433,776
  decisions and every one is a block declaration**. Throughput at parity (deterministic actions +0.05%
  to +3.5% — longer games, not slower code).

- 2026-08-23 worker: `fix/blink-rules-fidelity` ✅ MERGED + DEPLOYED — DESIGN §3.44. Off `main`. **5217 / 0**, verify 0.
- 2026-08-23 integrator: **`feat/modal-one-or-more` MERGED + DEPLOYED** — the "Choose one or
  more —" header plus `enchantment` / `land` / `planeswalker` as target restrictions of their
  own; Casualties of War compiles with all five modes. Audit: **585 → 586**. `npm run verify`
  green, build exit 0.
  👉 The header rides the existing count table with an unbounded ceiling the build site
  already clamps to the menu (`max = modes.length`); the cast-time mode/aim pipeline needed
  nothing — it was built mode-count-agnostic.
  ⚠️ **One existing test changed because its FIXTURE went stale, not its property:**
  `targeting.test.ts` used `'planeswalker'` as its junk-restriction example, and that word is a
  real restriction now. When you promote a word into a closed vocabulary, grep the tests for the
  word being used as the canonical NON-member.
  (Integrator)

- 2026-08-23 integrator: **`feat/cost-reduction` MERGED + DEPLOYED** — "TYPE/COLOUR spells you
  cast cost {N} less to cast" (Goblin Electromancer, the whole Medallion cycle, Etherium
  Sculptor). Audit: **571 → 585 playable**. `npm run verify` **5255 / 0**, build exit 0.
  👉 **`castManaCostFor(state, caster, castDef, base)`** — ONE exported helper applied at BOTH
  the offer (`offerCastsOf`) and the pay (`applyCastSpell`), so a spell a Medallion makes
  affordable is offered AND accepted. It wraps whatever cost is actually being paid — printed,
  flashback, madness — because CR 601.2f applies reductions to alternative costs too. Reduces
  the GENERIC portion only (never a pip: {U}{U} under Sapphire Medallion stays {U}{U}); copies
  stack; controller-scoped.
  👉 Data model: `CardDefinition.castCostReduction = { amount, filter? }` with the shared
  `CardFilter` naming the spell scope (types or colours). Compile rule is a CLOSED scope list
  (instant-and-sorcery / creature / noncreature / artifact / enchantment / five colours);
  "spells your OPPONENTS cast cost more" is a different system and does not match.
  ⚠️ **KNOWN, deliberate gap: the PILOTS do not read reductions when planning taps.** The menu
  is engine-built so nothing illegal happens, but a pilot funds the PRINTED cost — it may
  overtap (mana floats, wasted) or skip a cast the reduction made affordable (its own
  affordability check is printed-cost). No gauntlet deck carries a reducer today, so no recorded
  baseline moves; whoever teaches the planners should route them through `castManaCostFor`.
  (Integrator)

- 2026-08-23 integrator: **`feat/karoo-lands` MERGED + DEPLOYED** — the two most-repeated missing
  clauses in the corpus, closed together. Audit (same corpus): **559 → 571 playable**. `npm run
  verify` **5248 / 0**, build exit 0. The whole karoo cycle (Dimir Aqueduct + 9 cousins) and the
  Exploration family compile complete.
  👉 **`returnChosenToHand`** (choice-primitives): "return a land you control to its owner's
  hand" is a CHOICE, not a target — the printed line names no target, so the permanent is picked as
  the trigger resolves, by its controller, `sacrificeChosen`'s exact shape. The menu includes the
  karoo ITSELF on purpose (bouncing it is a legal, sometimes right, play). Classified LIBRARY_SAFE.
  👉 **`CardDefinition.additionalLandPlays`** + engine helper `maxLandPlaysFor` — ONE definition
  read at both the offer (`generateLegalActions`) and the apply (`applyPlayLand`), so the menu can
  never offer a land drop the engine refuses. Controller-scoped; copies stack ("two additional
  lands" = 2).
  ⚠️ **Rule-table placement trap:** a permanent's plain static line ("You may play an additional
  land…") is dispatched against STATIC_RULES — a rule for it in EFFECT_RULES never fires and the
  card silently keeps reporting. Check `compileAbilityLine`'s dispatch order before adding a rule.
  ❌ NOT done: Dryad of the Ilysian Grove (its other line needs land-type-changing statics),
  Oracle of Mul Daya (play-from-library), The Gitrog Monster (several systems). The clause
  compiles on all of them; the cards stay honestly blocked on their other lines.
  (Integrator)

- 2026-08-23 integrator: **`feat/copy-templates` MERGED + DEPLOYED** — the corpus's top gap
  family, four extensions in one branch. `npm run verify` **5218 / 0**, build exit 0. Audit
  (same saved corpus, before/after): **555 → 559 playable** — Lithoform Engine, Extravagant
  Replication, Skyclave Relic now compile complete.
  ❗ **NEW: the stack can tell an ACTIVATED ability from a TRIGGERED one.**
  `TriggeredStackObject.origin: 'activated'` is stamped by `applyActivateAbility` and cycling
  (absence = a genuine trigger). This FIXED a live infidelity: `'triggeredAbilityYouControl'`
  (Strionic Resonator) accepted activated abilities — quietly wider than printed — and now
  refuses them; the new `'activatedOrTriggeredAbilityYouControl'` takes both. ⚠️ Anyone adding
  a stack-object field: `internal/clone.ts` copies field by field — add it there or the next
  action drops it silently.
  👉 **Four new target restrictions**: `instantOrSorcerySpellYouControl`,
  `permanentSpellYouControl` (the complement — permanent spells; copies of those already become
  tokens via `spell-copy.ts`), `activatedOrTriggeredAbilityYouControl`,
  `nonlandPermanentYouControl`. All controller-scoped ones refuse an unknown actor.
  👉 **`compileTriggerBody` now lifts a targeted part when the rule is unflagged but its
  effects DECLARE a restriction** — `create-token-copy` cannot carry `needsChosenTarget` (its
  `~` selector targets nothing), so before this a targeted token copy inside a trigger compiled
  with NO ability targets and would have resolved blank. Also lifts `excludeSelf` from ref
  params onto the ability (`targetsExcludeSelf`) — a flag left on the ref alone excludes
  nothing, because the ABILITY is what gets aimed.
  👉 **Tapped token copies** ("create two TAPPED tokens that are copies…") ride the same
  `CopyExceptions.entersTapped` Vesuva uses. Found while doing it: **the plural head "tokens
  that are copies" NEVER matched** — the old alternation needed the literal "thats are copies"
  — so every plural-head token-copy card was reporting on a typo-shaped regex, not on a missing
  system.
  👉 **ETB intervening "if"**: `trigger-etb` now splits the printed "if COND," with the same
  closed vocabulary the step-trigger family uses, plus a new `InterveningIf` kind
  `sourceKicked` ("if it was kicked" — reads the `timesKicked` the kicked entry already wrote,
  which is written BEFORE the zoneChange emit, so the queue-time check sees it). An unreadable
  "if" still refuses the whole line. Note: `sourceKicked` fails when the source has left the
  battlefield — narrower than CR (a historical fact stays true), the safe direction.
  ⚠️ **Audit workflow trap:** `coverage-audit.mjs` reads the built DIST — regenerating the
  backlog after a rules edit without `npm run build` writes the OLD hints into the file. Also:
  `--save-corpus` + `--input` makes the before/after measurement offline and identical-corpus.
  ❌ **NOT done, deliberately** (each still reporting): "nonlegendary"/"token" target selectors,
  "copy THAT spell" (needs the triggering spell threaded into the trigger context), for-each
  iteration (Second Harvest, Kambal), follow-up sentences about the token just created, "except"
  tails on SPELL copies, quoted granted abilities (Electroduplicate's sacrifice rider). Most of
  the 29-card family is ALSO blocked by Spree/Class/d20 — the audit's per-card counts overstate
  what any one fix frees.
  (Integrator)- 2026-08-23 worker: `fix/blink-rules-fidelity` ✅ MERGED + DEPLOYED — DESIGN §3.44. Off `main`. **5217 / 0**, verify 0.
  Owns packages/core + packages/cards only; does not touch packages/ai or apps/web.

  A printed-card audit of all 16 distinct **Selesnya Blink** cards against fresh Scryfall Oracle text.
  **All 16 are faithful** — Thragtusk's two halves, the Closet's "your end step", Wood Elves' UNTAPPED
  Forest, Eternal Witness on any card type, the white Soldier, Restoration Angel's flash and its
  non-Angel restriction. `fidelity.test.ts` already guards the definitions; this asked whether the
  ENGINE plays them as printed.

  ⚠️ **Three defects, one root cause, and it will bite anything else that returns an id.** A blink
  puts the SAME instance id back on the battlefield, and three rules here were enforced only by an id
  ceasing to be there: removal from combat (CR 506.4 — a blinked attacker still connected for full
  damage AND came back untapped), the attachment SBA (CR 704.5m/n — an Aura stayed on a creature it
  had never enchanted), and floating continuous effects (CR 400.7 — a Giant Growth survived, and so
  did a "gain control until end of turn", so blinking a STOLEN creature handed it back at end of turn,
  the opposite of what §3.35 claims). If you write another same-id return (a reanimation that reuses
  the instance, a "return it at the next end step" delayed blink), call the same three.

  ⚠️ **`combat.attackers` / `combat.blocks` are the DECLARATION and are not rewritten.** Removal is an
  optional overlay (`CombatState.removedFromCombat`) read through `attackingCreatureIds`, because
  "was this attacker blocked?" is derived from `blocks` — deleting a removed blocker's entry would
  promote its attacker to unblocked. New `CombatState` fields must also be added to `cloneCombat`
  **and** to `instance-ids.ts` (the leak scanner's source scan fails the build otherwise — that is the
  one test my first pass turned red).

  ⚠️ **A fourth defect, and the audit that could not see it. `Serra Angel` was not an Angel.** Ten
  hand-authored cards in `packages/cards/data/pool.ts` carried NO subtypes — so Restoration Angel's
  printed "target **non-Angel** creature you control" did not exclude Serra Angel, Goblin Chieftain
  did not see Goblin Guide, and Ophiomancer's intervening "if" did not see Sakura-Tribe Elder.
  §3.41's Angel sweep went 32 deep through the GENERATED pool and never opened the curated file.
  `fidelity.test.ts` compares a *behaviour signature* and deliberately leaves the frame to "the
  compiler's ground-truth suite" — which tests the compiler, not a hand-typed definition, so a
  hand-authored frame had no guard at all. It now also asserts printed subtypes for every pool card.
  **If you hand-author a card, the frame is not audited by the behaviour signature.**

  Sabotage-checked one line at a time: each of the three blink calls turns exactly its own two tests
  red, and deleting Serra Angel's `subtypes` turns the new type-line guard and the new Restoration
  Angel case red.

  📊 **Selesnya Blink gauntlet seed 99 byte-identical** to `main` — 58 · 43 · 57 · 32 · 38 · 34 · 31 ·
  51, 344/480, 6 timeout draws — because no curated list blinks into combat, runs an Aura next to
  Cloudshift, or pairs a typal payoff with one of the ten curated cards. No baseline to re-record.
  Throughput unchanged (interleaved 300-game runs, both ~29–35 games/sec).

- 2026-08-23 DESKTOP-90PJPM4: `feat/play-vs-ai` ✅ MERGED + DEPLOYED — DESIGN §3.43. Off `main`. **5208 / 0**,
  verify 0, browser-verified.

  Play tab gains a third tile: **Solo (vs the computer)** with a pilot picker (heuristic / hybrid /
  mcts / random). Built on `SeatTransport`, documented from day one as the seam a non-hotseat mode
  plugs into — solo needs only `localControls: seat === human` (the pilot's hand is hidden by the SAME
  masking an online opponent gets) and `requiresHandoff: false`.

  ⚠️ **ONE game component, not a solo fork.** `LocalPlay` takes an optional `ai` config; the modes
  differ in three places and share everything else. A forked `SoloPlay` would have been a second copy
  of mulligans/board/log/rematch/concede.

  ⚠️ The AI driver is ONE effect, because the engine presents every decision identically — a parked
  question is an `answerChoice` in `legalActions`, exactly as in `match.ts`. Do not add a branch per
  situation here; it would drift from how the sim plays the same board. Rejected action ⇒ pass, the
  same wedge-guard the sim keeps.

  Reused the Lab's `PilotPicker` with an overridable label (the Lab's "AI pilot (both seats)" is
  actively wrong copy in the Play tab). apps/web ONLY — no engine change, no baseline moved.
- 2026-08-22 integrator: **`feat/shocklands` DEPLOYED to main** (Deploy PWA green, run
  32623813098). Merged the newest `main` into the branch first (it had meanwhile gained
  §3.41/§3.42 and the soak suite) — clean auto-merge — then `npm run verify` on the union:
  **5207 passed / 0 failed**, build exit 0. Also added the payLife answer-boundary tests (both
  sides of `desperateLifeThreshold`) and the web pay-life prompt drafting tests.
  ⚠️ **Trap:** after merging a main that gained new packages, `npm run build` failed with
  "Cannot find module '@jonny-boi/core'" from protocol/cards — a STALE `npm install`, not a type
  error. Re-run `npm install` in the worktree before debugging anyone's types.
  (Integrator)

- 2026-08-22 DESKTOP-90PJPM4: `fix/blink-aim` ✅ MERGED + DEPLOYED — DESIGN §3.42. Off `main`. **5201 / 0**, verify 0.

  Answering "are all 60 Selesnya Blink cards functional?" — they ARE — surfaced a much wider AI bug.
  The deck exiled 171 cards and returned 161; the missing ten were its OWN TOKENS (9 Soldier, 1 Beast)
  blinked and destroyed.

  ⚠️ **`mayEffects` had NO ENTRY in the AI value table.** An unpriced primitive scores the flat
  unknown constant and its nested body is never read — so a pilot aiming an OPTIONAL trigger scored
  every candidate identically and took the FIRST offered. **Ten pool cards route through
  `mayEffects`**, so this was never a blink bug. If you add a wrapper primitive, add its value entry
  in the same commit or every card behind it becomes invisible to the pilot.

  `blinkTarget` priced too — by what re-entering re-triggers, deliberately NOT via `againstTarget`
  (which penalises aiming at your own board, backwards for blink), and a TOKEN priced as a LOSS.

  📊 Tokens blinked away 10/40 games → 1. Selesnya Blink gauntlet **63.0% → 71.0%**, non-overlapping
  CIs. ⚠️ **BASELINES MOVE**: Mono-Red unchanged (224/800), UW Control 434 → 426/800 — its opponents
  now play optional cards better. Re-record if you depend on those rows.

  ⚠️ Three FIXTURE bugs while writing the test, all making it disagree with the game for reasons not
  in the code: an ETB missing the printed `who` param, and an EMPTY LIBRARY (which prices any draw as
  decking yourself). Use real pool cards and give seats a library.

- 2026-08-22 DESKTOP-90PJPM4: `feat/angels` ✅ MERGED + DEPLOYED — DESIGN §3.41. Off `main`. **5196 / 0**,
  verify 0, gauntlet seed 99 byte-identical (224/800).

  **Angel of Serenity plays** — the last card §3.38 left blocked — and it needed two engine gaps
  closed. (1) **Multi-target triggers**: targeting was single-target everywhere, but the engine was
  already asking a `selectTargets` choice to aim a trigger, hard-coded `min:1,max:1`. `targetCount`
  on the ability now drives it; absent ⇒ one, so nothing else changes, and targets are still chosen
  ON THE STACK (CR 603.3d) rather than deferred to resolution. ⚠️ `min: 0` is load-bearing — "up to
  three" with no legal targets must STAY on the stack and do nothing, where a must-target trigger is
  removed; removing it would silently delete the rest of the card. (2) **Multi-zone targets**:
  `creatureOnBattlefieldOrInGraveyard`, the pool's only two-zone target list. ONE restriction, because
  "up to three" is three in total across both zones, and BOTH graveyards — it does not say "your".

  ⚠️ A graveyard card is not a permanent, so `exileUntilLeaves` needed a second path: the battlefield
  leave-funnel does not apply to it. Both sabotage-checked (drop the `max` cap → red; return to
  battlefield instead of hand → red).

  📊 **The Angel type swept: 6 → 32 playable.** 143 of 169 candidates still rejected, needing ~71
  DISTINCT templates between them — a long tail, not a task. Pool 529 → 555 compiled.

- 2026-08-22 DESKTOP-90PJPM4: `feat/pilot-pays-for-abilities` ✅ MERGED + DEPLOYED — DESIGN §3.40. Off `main`.
  Suite **5113 / 0**, lint clean.

  ⚠️ **§3.39's "known gap" was a WRONG DIAGNOSIS and is now corrected in DESIGN.** I reported that the
  pilot could not plan a mana payment, backed by "122 opportunities, 0 offers". The measurement was
  real; the cause was not. `isTargetRestriction` had never been given the new restriction word, so
  `restrictionOfEffects` returned `undefined`, the ENGINE never offered the activation, and the pilot
  scored it zero. A missing line in a validator wearing the costume of an AI limitation.

  ⚠️ **A restriction word has FIVE homes** — the union, `isTargetRestriction`, `isLegalTarget`,
  `enumerateTargets`, `describeRestriction`. Missing the validator fails SILENTLY and looks exactly
  like a pilot that is not clever enough. Adding one? grep an existing word and confirm five hits.

  **The pilot gap was ALSO real** — both fixes were needed; with only the validator fixed,
  `trigger-copy` still reported inert. `bestFundedActivation` generalises what `bestEquipPlay` did for
  Equip alone: the engine offers an activation only once the pool already covers its cost and the
  pilot never floats mana speculatively, so every mana-costed ability was invisible to it. Scored with
  `valueOfEffects` (the ruler loyalty/modal/triggers already use), funded with `planManaPayment`.
  Loyalty, Equip and land-fetch keep their own scorers — two paths bidding for one ability would
  double-count it against the spell it competes with.

  📊 **Gauntlet seed 99 BYTE-IDENTICAL to main**, every row, on Mono-Red Aggro (224/800) and UW Control
  (434/800, 53 timeouts). The curated decks hold no ability this path can price, so the behaviour
  appears only where such cards exist. `trigger-copy` is now a registered, FIRING soak mechanic.

  ⚠️ §3.39's loop-draw test was rewritten: it pinned a seed where the heuristic walked into the
  Dualcaster/Rite loop, and THIS change made the pilot win that game instead. A test that reddens
  because the pilot improved is measuring the wrong thing — it now pins the mechanism and asserts only
  that the copy-mirror board terminates.

  Still blocked: `Angel of Serenity` (multi-zone targeting — battlefield and/or graveyards).

- 2026-08-21 DESKTOP-90PJPM4: `feat/copy-triggered-ability` ✅ MERGED + DEPLOYED — Strionic Resonator, **and a
  game the rules end**. DESIGN §3.39. Off `main`. Suite **5112 / 0**.

  ⚠️ **Adding ONE card turned the soak red, and the card was not in the failing game.** Anchored decks
  are a pure function of the pool, so a 529th card reshuffles all of them; the new pairing dealt
  **Dualcaster Mage + Rite of Replication** — a genuine MANDATORY infinite loop in paper Magic (neither
  half is a "may"). 2,138 tokens, 6,000-action cap. Expect this whenever you add to the pool: a red
  soak after a pool change is often a NEW DECK, not a new bug.

  **CR 104.4b now ends it.** `SimConfig.maxActionsPerTurn` (2,000) → outcome `{kind:'loop'}`,
  deliberately not `'timeout'`: timeout means "we gave up, the verdict is suspect", loop means "the
  rules end it here". Soak COUNTS loop-draws and prints them instead of failing — legal, but a rising
  count is a finding. ⚠️ NOT the §3.33 copy mirror: that loop produced nothing, this one produces a
  real 2/2 per iteration, so the valuation is right to like it. Do not "fix" it in the pilot.

  ⚠️ **Known gap, MEASURED: the pilot cannot use Strionic Resonator.** The engine offers an activation
  only when the pool already covers its cost, so copying a trigger needs tapping lands in response to
  your own trigger — a two-step plan `bestAbility` does not make. Over six anchored games: Strionic
  untapped with a trigger on the stack **122 times, activation offered 0 times**. So `trigger-copy` is
  deliberately NOT registered as a soak-witnessed mechanic (it would fail the inert guard for a reason
  the card cannot fix), and the reason is written into `soak-config.ts` so nobody re-derives it. The
  card works for a HUMAN — the online board taps mana by hand. **Next work: teach `bestAbility` to plan
  a mana payment** — the same gap the online client's `tapCastable` documents, and it would unlock
  every mana-costed activated ability, not just this one.

  Still blocked: `Angel of Serenity` (multi-zone targeting — battlefield and/or graveyards).

- 2026-08-21 DESKTOP-90PJPM4: `feat/card-templates` ✅ MERGED + DEPLOYED (main = 5102 tests, verify 0) — **four more cards play; imports now
  re-compile.** DESIGN §3.38. Off `main`.

  ⚠️ **The half that matters most is not the cards: a failed import was a CACHE that never expired.**
  It stored the compiler's verdict from the day it was imported and nothing revisited it — so every
  template anyone adds from here would have had a dead zone, the card staying broken in a user's deck
  until they thought to delete and re-import. `Cloudshift` proved it: still reading "needs a
  filtered-targeting template" a full release after §3.35 shipped the rule compiling it. Failed
  entries now re-compile once per session on load.

  **O-Ring system** (`exile-until-leaves.ts`): Banisher Priest + Fiend Hunter. ⚠️ The LINK is the
  mechanic — the exiled card records who exiled it, so two jailers each return their own prisoner. A
  "return everything in exile" version passes the obvious test and fails that one; it is pinned and
  sabotage-checked. Banisher Priest's modern wording is ONE sentence producing TWO abilities, so that
  rule emits two triggers from one clause.

  ⚠️ **"another target creature" is a FLAG, not a fourth one-off restriction.** §3.37 warned against
  adding more `nonSomethingSomething` members to the restriction union; "another" is orthogonal to
  type, so it is `TriggeredAbility.targetsExcludeSelf`, applied where candidates are enumerated AND in
  `isLegalTarget`. Load-bearing: an unfiltered Fiend Hunter exiles itself → leaves → returns itself →
  triggers again, unbounded. Two genuinely type-shaped restrictions were still added
  (`creatureAnOpponentControls`, `artifactEnchantmentOrLand`) — that is the axis the union is good at.

  **Still blocked and NOT approximated:** `Angel of Serenity` needs multi-zone targeting ("creatures
  from the battlefield and/or creature cards from graveyards"); `Strionic Resonator` needs copying a
  TRIGGERED ABILITY, a copy system for non-spell stack objects. Both are engine work.

  Pool 524 → 528 compiled, surgical.

- 2026-08-21 integrator: 🚢 **SHIPPED** — merged to `main`, Deploy PWA green, live bundle
  `index-4Y4b98Ca.js` carries `Restoration Angel` and `nonAngelCreatureYouControl`. verify 0,
  **5086 passed / 0 failed**.

- 2026-08-21 DESKTOP-90PJPM4: `fix/pool-shadowed-by-import` ✅ MERGED — **a CURATED card was being
  reported "not playable", and Restoration Angel now compiles.** DESIGN §3.37. Branches off `main`
  (which now carries §3.33–§3.36).

  **The user-visible bug.** A deck builder showed "⚠ 10 cards not playable" including `Thragtusk`,
  `Cloudshift` and `Conjurer's Closet` — all three CURATED and playable. `unsupportedReason`
  consulted only the imported-card store, so a card that is both curated and imported was judged by
  the import. Both files promise this cannot happen (`importedCards.ts`: "nothing here can shadow a
  curated card"; `deckHealth.ts`: "cards in the curated pool are always playable") — true as
  documentation, false as code. Ask the pool first. ⚠️ Note the store is also a CACHE of an
  import-time verdict: Cloudshift's entry still said "needs a filtered-targeting template" after the
  rule compiling it had shipped. Curated cards are now immune; an uncurated failed import still
  carries its old verdict until re-imported, and a test pins that those are STILL reported (silencing
  every warning would be the worse bug).

  **Restoration Angel** needed the "filtered-targeting" gap the report kept naming:
  `nonAngelCreatureYouControl`. ⚠️ The exclusion is load-bearing — the Angel is a creature you
  control, so an unfiltered blink lets it re-trigger itself for ever (§3.33's shape). Applied at BOTH
  the enumeration site and `isLegalTarget`, because §3.36 is exactly what happens when those disagree.

  ⚠️ **Why it is a named member and not a general filter.** `CardFilter` already spells "non-Goblin
  creature" as `noneOfSubtypes`, so the general form is a restriction that carries a filter — but
  `TargetRestriction` is a flat string union read at **67 non-test sites**, and giving it a shape is a
  different size of change. The new member's comment names the trigger for doing it properly: the
  second non-<subtype> card. Do not add a third one-off.

  Pool 523 → 524 (surgical: 1 card added, 0 changed). Selesnya Blink swaps 2× Angel of Mercy for 2×
  Restoration Angel and reads **60.9%** (was 61.9%).

- 2026-08-21 integrator: 🚢 **SHIPPED — all four commits MERGED to `main` and DEPLOYED** (Deploy PWA
  green, 1m12s; https://cjacobscoding.github.io/jonny-boi-app/ returns 200 and the bundle contains
  both "Selesnya Blink" and "Cloudshift"). Fast-forward, no merge commit: `fix/soak-action-cap` →
  `feat/blink-selesnya` → `fix/returned-spell-keeps-back-face`. main = **5075 passed / 0 failed**,
  verify 0, deep soak **0 violations / 2,000 games**, gauntlet seed 99 rows byte-identical
  (12 · 13 · 17 · 7 · 9 · 7 · 14) plus the new Selesnya Blink row.

  The three in-flight rows above are now ✅ MERGED; leaving their notes in place because the two
  process lessons in them (a soak-seed "verification" that was really a pool change, and pinned rows
  that must carry their own decklists) are the reusable part.

- 2026-08-21 DESKTOP-90PJPM4: 🟢 **THE DEEP SOAK TIER IS GREEN — 0 violations in 2,000 games.** It
  has been red since 2026-08-20. Three distinct defects, found one behind the other by the same hunt:
  the copy mirror (§3.33), a returned spell keeping its cast face (§3.34), and a granted flashback on
  a SPLIT card (§3.36, on this branch). Same stack: `fix/soak-action-cap` → `feat/blink-selesnya` →
  `fix/returned-spell-keeps-back-face`.

  **§3.36.** Snapcaster grants flashback to a CARD; a split card cast from the graveyard resolves to
  a HALF, so `castDef !== card.def` and `applyCastSpell` read the half's PRINTED flashback (there is
  none) instead of the grant. `generateLegalActions` meanwhile offered the cast using
  `flashbackCostOf(state, card)`, which finds the grant and even checks affordability against it —
  so the menu offered a cast the apply path refused for ever. Both sides now read the same accessor,
  which settles the cost question without a ruling: the apply charges the number the offer validated.
  Seed 1200969370, an `Assault // Battery` already spent as Assault.

  ⚠️ **The invariant is the lesson.** "The engine never rejects an action it offered" is not a rules
  check — it compares two code paths that must agree, and nothing else in the suite does. Worth
  keeping in mind when adding any second reader of a legality question.

- 2026-08-21 DESKTOP-90PJPM4: `fix/returned-spell-keeps-back-face` 🚧 PUSHED — **§3.34 closed, and my
  first diagnosis of it was WRONG.** ⚠️ Stacks on `feat/blink-selesnya` → `fix/soak-action-cap`.

  §3.34 said the pilot was building `castSpell` for a modal DFC whose back face is a LAND, and
  prescribed a guard in `castableHalvesInHand`. **I wrote that guard and it fixed nothing** — the
  caller already drops a land half one line later (`if (isLand(def)) continue;`), so it was
  unreachable code. The seed I "verified" against had gone green because §3.35 changed the pool and
  re-dealt it, not because of the guard. I only caught it by removing the guard and watching the seed
  still pass. **`targets:['B']` was the tell the whole time: a land does not target a player.**

  **The real defect.** Trace every event naming the instance and you get three lines: DRAWN, CAST as
  its back half ("Blow Off Steam"), then **stack → hand** — Narset's Reversal. `returnSpellToHand`
  pushed the instance into the hand array with three hand-rolled lines and NO CR 400.7 reset, so it
  arrived still wearing the back-face definition. A back face cannot be cast from hand (CR 712.8b),
  so the engine refused it every time the pilot offered it: same rejected action **82 times in one
  game**, and a dead draw for the rest of it. Fix calls core's own `resetInstanceForNewZone` +
  `pruneCardGrantsFor` instead of re-implementing what a zone change clears — the drift
  `movePermanentTo`'s comment warns about, in the sibling funnel.

  ⚠️ **The regression is CONSTRUCTIVE, not a seed** (`returned-spell-face.test.ts`): cast a modal
  DFC's back half, bounce it, assert the card in hand is front-face-up AND castable again. A seed
  would be re-dealt by the next pool change — which is literally what invalidated my first attempt.
  Sabotage-checked: removing the reset turns both tests red.

  Two lessons for the board, both cheap to repeat: **a fix verified only against a soak seed is not
  verified** if the pool moved underneath it — remove the fix and confirm the seed goes RED before
  believing it. And **read the action's own fields**; the target list contradicted my hypothesis
  before I wrote a line of code.

- 2026-08-21 DESKTOP-90PJPM4: `feat/blink-selesnya` 🚧 PUSHED — **BLINK SHIPPED; `Selesnya Blink` is
  the ninth sample deck** and is selectable online. DESIGN §3.35. ⚠️ **Stacks on
  `fix/soak-action-cap`** (both touch `packages/ai/effect-value.ts`/`heuristic.ts`) — merge that first.

  Blink was on §3.21's ⛔ named-unsupported list, so the deck was not "broken", it was
  **unbuildable**: no primitive, no enabler in the pool. Now `blinkTarget` + `blinkSelf`
  (`packages/cards/src/blink-primitives.ts`), one compile rule, and two real pool cards.

  **What the mechanic IS: CR 400.7 — a new object.** The ETB fires again (the payoff); counters,
  damage and Auras do not return, and it comes back untapped and summoning-sick (the cost). Built by
  composing the two EXISTING zone funnels (`movePermanentTo` out, `putOntoBattlefield` back) rather
  than a third opinion about zone changes — `effect-helpers.ts` already carries a scar comment about
  the last time those drifted. `putOntoBattlefield` gained one optional `controller`, because a card
  goes to its OWNER's exile (CR 400.3) but returns under the BLINKER's control.

  **One rule, two cards** — the wrappers already existed, so the step-trigger prefix gives Conjurer's
  Closet and `you may` makes it optional, while the bare clause is Cloudshift. Pool regeneration was
  surgical: **exactly 2 cards added, 0 changed**.

  ⚠️ **The pilot half is not optional, and this is the number that proves it.** Engine working, no
  valuation: Conjurer's Closet blinked **94 times in 20 games** (a `you may` trigger the pilot already
  accepts) while Cloudshift was cast **ZERO** times — an unclassified primitive is a "generic spell",
  and a generic spell is only offered into an empty stack. The deck looked functional while its best
  card rotted in hand. Adding the `blink` goal → **45 Cloudshifts** and **55.9% → 61.9%**.

  ⚠️ **Deck ORDER is load-bearing and cost me a baseline once.** A gauntlet matchup is seeded by the
  opponent's INDEX (`gameSeedFor(baseSeed, i)`), so inserting a deck mid-list reseeds everything after
  it: slotting Selesnya Blink into the curve order moved UW Control's row 14 → 12 while changing
  nothing about how either deck plays. **Append new decks to `SAMPLE_DECKS`, never insert.** Appended,
  all seven recorded rows are byte-identical (12 · 13 · 17 · 7 · 9 · 7 · 14) with an eighth added.

  📊 It is the STRONGEST deck in the gauntlet at **61.9%** (95% vs Mono-Red, 100% vs Rakdos Goblins;
  27.5% into Mono-Green Ramp, 37.5% into Izzet Prowess). Whether the meta wants a 62% deck is a
  TUNING call for the integrator — flagging it rather than quietly shipping it.

  ⚠️ **PINNED SOAK ROWS NOW CARRY THEIR OWN DECKLISTS — read this before your next pool change.**
  Adding two cards re-sampled every generated deck, so three of §3.33's four pinned rows began
  replaying a DIFFERENT match and their `mustContain` guards fired. The guard did its job; the
  problem is what is left afterwards — the bugs are still fixed, the positions are simply no longer
  dealt, and an **8,000-game hunt with the copy fix reverted did not re-deal the mirror once**.
  Re-pinning fresh seeds would only survive until the next card lands. So `replaySoakMixedGame` now
  takes an optional `decks`, and `soak-pinned-decks.ts` records the exact decklists (Scryfall UUIDs —
  stable across churn; only the SAMPLING moved). **Any future pool change leaves these rows alone.**
  Sabotage-verified that this did not hollow them out: reverting the copy chain walk still turns all
  three copy rows red, and disabling the CR 704.3 check still turns the SBA row red with its original
  `#34 Blood Artist has toughness 0`.

  Also updated for the +2 cards: `pool.test.ts` expected size 521 → 523, and the two new primitives
  are classified in `paired-arms-config.ts` (SAFE — a blink keeps the card's own decklist instance id,
  so an ETB library read is attributed to the card that made it, unlike `copyAsEnters`).

  **Still out, deliberately left in the candidate list so the report keeps counting them:** the
  DELAYED-return half (Flickerwisp, Eerie Interlude, Ghostway, Charming Prince's third mode) needs
  delayed triggers; Ephemerate additionally needs rebound and prints "under its **owner's** control";
  Teleportation Circle needs "up to one target artifact or creature".

- 2026-08-21 DESKTOP-90PJPM4: `fix/soak-action-cap` 🚧 PUSHED — **§3.32's three action-cap games are
  fixed; the deep tier's `gameCanEnd` is GREEN (3 → 0 in 2,000 games).** DESIGN §3.33.

  **All three seeds were ONE bug, and the extra-draw engines in their decklists were a red herring.**
  It is the copy MIRROR: two copy spells on the stack are each other's legal targets, and
  `EFFECT_VALUE.copySpell` priced a copy at the copied CARD's face value — so "copy the Twincast"
  always outscored "copy the Dream Twist underneath it", and what it bought was another Twincast
  copy. Instrumented replay of 1390617766: **1,891 `spellCopied` events in one game** against 8
  casts. A copy is now priced by what its chain actually DELIVERS (walk to the non-copy spell at the
  end; a chain whose target already left the stack is 0, CR 608.2b).

  ⚠️ **Read this before touching the new weight.** `modeCopyChainPenalty` is NOT what fixes the loop
  — the chain walk is. With the penalty at 0 all three seeds still pass, because the candidates then
  score EQUAL and the tie happens to fall to the real spell. That is correctness by candidate
  ordering. The penalty makes it strict, and the test asserts `bolt > mirror` rather than only the
  configured gap — assert the gap alone and `0 === 0` passes with the loop wide open.

  Also fixed a real CR 707.10 infidelity found on the way: `retargetCopy` asked for an EXACT target
  count, which only lets you decline while the inherited target is still legal. Once it has left the
  stack it is not a candidate, so "leave it alone" became unsayable — and with exactly one other
  candidate the exact count made the question AUTO-ANSWERABLE, so the engine silently aimed the copy
  at the only other copy spell without asking anyone. Now `min: 0` in that case.

  Sabotage-checked 3 ways, all caught: revert the chain walk → 4 pilot tests + 3 pinned seeds red;
  zero the penalty → 2 pilot tests red; revert the `min` → the optionality tests red.

  ⚠️ **HANDOFF — the tier is STILL RED, for something else this made reachable (DESIGN §3.34).**
  Seed **1490533871**, turn 22, **draw step**: the pilot submits
  `{castSpell, instanceId:7, targets:['B'], face:'back'}` **82 times** and the engine refuses it
  ("the back face of a double-faced card cannot be cast"). A modal DFC whose back face is a LAND
  (`Skyclave Cleric // Skyclave Basilica`) is marked `backFaceCastable: true` — and **that flag is
  correct**; `compile.ts` documents it as "both halves are cast **or played** from hand". The pilot
  reads it as *castable* and builds a `castSpell` for a land; `playLand` has taken `face?: CastFace`
  since §3.13 for exactly this. **21 pool cards** carry a land back face (9 Pathways + the Zendikar
  MDFCs + Glasswing Grace, Revitalizing Repast, Vastwood Fortification), so any of them can deal it.
  ⚠️ Do NOT "fix" it in `data/expanded-pool.ts` — that file is generated and a test re-derives it.

  Proved it is not mine, both directions: revert this branch and seed 1490533871 replays **clean at
  both seats**, and the pre-fix 2,000-game tier reports **3 violations, all action-cap, zero DFC**.

  ✅ verify 0, build 0, **5060 passed / 0 failed**, gauntlet seed 99 **79/280** byte-identical
  (rows 12 · 13 · 17 · 7 · 9 · 7 · 14) — no curated deck holds a copy spell, so curated play cannot
  reach the changed code at all.

- 2026-08-20 worker: `fix/sba-toughness-violation` 🚧 PUSHED — **the CR 704.3 boundary was
  installed on ONE of the doors into "a player would receive priority"; paying a spell's additional
  cost walks through another one.** DESIGN §3.32 (§3.31 went to `feat/spell-and-token-copies`
  while this was in flight). Closes the violation `fix/redaction-guarantee`
  deferred (seed 4222011655, `#34 Blood Artist has toughness 0`).

  **Which of the three it was.** Not the narrowed gate — `stateBasedActionsPossible` answered
  **true** on the offending board (the Weakness is an attachment, and either end of an attachment is
  an "always look"), so §3.29's `MODIFICATION_IS_PURELY_ADDITIVE` narrowing is innocent. Not a stale
  toughness — calling `checkStateBasedActions` **by hand** on that exact state killed the creature
  and emitted the whole correct cascade. It was **a mutation site that never re-checked**: Costly
  Plunder's mandatory additional cost (CR 601.2h) sacrificed the Trusty Machete that was holding a
  Weakness-ed Blood Artist above zero toughness, and `finishCastChoice` hands the floor straight back
  to the caster — nobody passes priority, so `onPassPriority` never runs. The 0/0 sat on the
  battlefield for **five turns**.

  **The seam.** `applyActionToDraft`, after dispatch and **before** `collector.flush()` — SBAs then
  triggers, which is CR 704.3's own order and is what lets a death this check causes queue its
  dies-trigger into the same flush. Guarded on "is anybody actually receiving priority" (not gameOver,
  no parked question, no suspended resolution) and behind the same cheap gate. **The pass is excluded
  on purpose**: it already runs this check at its START, where it must be (an SBA can end the game or
  park the legend rule and so stop the pass), and 125,918 of the gauntlet's 151,124 actions are passes.

  ⚠️ **If you add a new `GameAction` kind, it is covered automatically** — the exclusion is written
  as `action.kind !== 'passPriority'`, not as a list of the kinds that need checking. Enumerating
  mutation sites is what produced this bug.

  **Cost, counted before it was timed** (⚠️ the first paired attempt read 2,484 ms and 5,110 ms **for
  the same arm** — a few CPU rounds are not a measurement on this box either). Gauntlet: +24,965 gate
  calls, **zero** extra full checks (curated decks rarely hold an attachment) ≈ 6 ms of ~2.3 s, rows
  byte-identical. Full-pool soak, the worst case: +11,328 gate calls and +6,227 full checks
  (24,369 → 30,596, +25.6%) for **+9.5% CPU**, minimum over 14 alternating paired rounds in one process.

  **A sabotage escaped, and that is the finding.** `soak.test.ts` gains a PINNED replay list built on
  a new `replaySoakMixedGame` (one seed → one game → 200 ms; the tier's promise that "a violation is
  a bug report you can paste into a new test" was previously only half true, since mixed game 112 is
  three times past the fast tier's reach). Flipping one bit of the replay's opponent-deck seed left
  the pinned row **GREEN** — it replayed a different match, found nothing, and read exactly like a fix
  holding. The replay now returns both decklists and every pinned row asserts the cards without which
  the position cannot exist, **before** asserting the outcome. **4 sabotages, 3 caught, 1 escape,
  fixed and re-checked red.** If you add a pinned row, name its cards.

  📊 **The sibling hunt, 2,000-game deep tier on the merged tree**: 2,056 games, 1,122,195 actions,
  **zero** SBA-class violations — no 0-toughness creature, no 0-loyalty walker, no 0-defense battle, no
  illegal attachment, no player at 0 life still playing.

  ⚠️ **HANDOFF — `origin/main`'s deep soak is RED, and it is not this branch.** Three games burn the
  6,000-action cap without ending (`gameCanEnd`): seeds **3434778477**, **1390617766**, **113343071**.
  Replayed with the new check ON and OFF in one process, at both on-the-play seats, the violation sets
  are **identical** — pre-existing. Every one of the three decks pairs a copy spell (`Reverberate`,
  `Twincast`, `Narset's Reversal`) with an extra-draw engine (`Howling Mine`, `Font of Mythos`,
  `Kami of the Crescent Moon`), i.e. §3.31's new cards meeting a card-advantage board. `replaySoakMixedGame`
  reproduces each in ~200 ms — whoever takes it should start there.

  ✅ verify 0, build 0, **5009 passed / 0 failed**, gauntlet seed 99 **79/280** with all seven rows
  byte-identical to the recorded baseline.


- 2026-08-20 worker: `feat/spell-and-token-copies` 🚧 PUSHED — **the corpus's #1 gap is closed, and
  it was closed the way `feat/copy-effects` said it had to be.** That branch reported copying a SPELL
  and TOKEN COPIES by name rather than half-building them, and named the trap precisely: a copy needs
  a stack object that is **not a card** and that ceases to exist as it resolves, because
  `resolvesTo` offers only battlefield/graveyard/exile/hand and **every one of them leaves a phantom
  CARD** in a zone delirium, flashback and Tarmogoyf all count. That was exactly right.

  📊 **Measured, paired, same cached 2100-card corpus, against the `origin/main` this merges into
  (`ab0e41a`): 545 → 550 playable, +5, 0 regressions** — I diffed the two full playable SETS, not the
  counts. Reverberate, Reiterate, Narset's Reversal, Rite of Replication, Giant Adephage. The shipped
  pool is **545 → 553** (Twincast, Cackling Counterpart and **Dualcaster Mage** join too — the last
  one copies a spell from an ETB TRIGGER, aimed as the trigger goes on the stack).

  👻 **HOW THE PHANTOM IS AVOIDED — the one thing worth copying rather than re-deriving.**
  `spellLeaveDestination` gains a FOURTH answer, `'ceaseToExist'` (CR 704.5e), asked **first** so it
  outranks flashback's exile, buyback's return to hand and the graveyard. Both exits from the stack
  already funnel through that one function and they live in **two different packages** (core's
  `finishSpellResolution`, the cards package's `counterSpellOnStack`) — which is exactly why the
  answer is a value in a RETURN TYPE and not an `if` at each call site: neither caller type-checks
  without handling it, and the compiler caught the second the moment the type widened. Nothing is
  ever pushed into a zone, so there is no phantom to clean up. A copy of a PERMANENT spell is the one
  copy that keeps an object, and it keeps it as a **token** (stamped on the DEFINITION, which
  survives the per-action clone by construction).

  ⚠️ **TWO LATENT ENGINE BUGS, both older than this branch, both fixed here:**
  1. `applyAnswerChoice` routed **every** `selectTargets` answer to `recordTriggerTargets` with no
     `!state.resolution` guard — the three sibling branches beside it all have one. Any target
     question raised from inside a resolution would have aimed an unrelated trigger and parked the
     suspended resolution forever.
  2. `targetOptionFor` never searched the **stack**, so every counterspell's own target has been
     rendering as `#7` to the UI and to the AI's target scorer since "target spell" existed.

  ⚠️ **THE FULL-POOL SOAK CAUGHT THE MECHANIC INERT, AND IT WAS THE PILOT — worth knowing if you
  ship anything castable in response.** The pool printed `spell-copy` and no soak game fired it. The
  heuristic classifies spells by INTENT; `copySpell` was in no intent, so a Reverberate was a
  "generic spell", and a generic spell is offered **only with an empty stack**. The pilot could never
  cast it. A `copySpell` intent (a counterspell's timing, the opposite sign) fixes it and the soak
  goes green. **§3.26 earned its keep here.**

  🎯 **The pilot also needed a re-aim policy, and the default was actively bad.**
  `answerSelectTargets` had two cases (a modal cast, a trigger); "you may choose new targets for the
  copy" is a THIRD, asked from inside a resolution. With nothing to price, every candidate scores
  zero and the pilot takes the FIRST offered — which for a copy of a Lightning Bolt is very often its
  own face. It now reads the spell being COPIED off the resolving frame's own target.

  📚 **CR 707, NOT CR 706 — please do not re-introduce it.** Copying objects is section **707**; 706
  is rolling a die. The repo cited 706 in 24 files. `conformance/rules-manifest.ts` already had it
  right and five anchors in that same file confirm the numbering (708 face-down, 709 split, 712 DFC,
  715 adventurer). Corrected throughout the source; DESIGN §3.24's prose still says 706 and is left
  for its owner.

  🧪 **21 tests, 20/21 sabotages RED first pass.** The survivor is instructive rather than a hole:
  nulling ONE of the two `spell-copy` soak witnesses changes nothing because they cover each other
  (exactly as `tokenCreated`/`tokenCeasedToExist` do), and the case that matters — a copy created but
  never ceasing to exist — fires only the first, so it still fails. Two real product bugs were found
  by tests rather than review: `createTokenCopy` never implemented the `self` selector the compiler
  emits, and `spellCopyAimRestriction` read `targetRestrictionOf` literally (which answers
  `undefined` for the default `'any'`, so Lightning Bolt could never have been re-aimed).

  🪤 **A TRAP THAT WILL BITE THE NEXT AGENT: `applyAction` takes `(state, action, CONFIG, REGISTRY)`
  POSITIONALLY.** Passing `{ registry, config }` — which reads like an options object and which
  several existing suites in this repo do — puts the object in `config` and leaves the registry
  UNDEFINED, so every primitive degrades to `effectUnsupported` and your test stays GREEN while
  proving nothing. It cost an hour here.

  🔒 **`ABILITY_ACQUIRING_DEFINITION_FIELDS` was answered deliberately and left ALONE**, with the
  rule for whoever adds the next copy system written into the file: a field belongs there when the
  copy is applied to an object that KEEPS its instance id (a Clone does — `sourceCardFor` places it
  and reads the wrong card), and does not when the copy is a NEW object (a spell copy and a token get
  minted ids outside both decklist ranges, so the runner already takes its conservative branch).
  "Becomes a copy" by an activated ability (Mirage Mirror, Thespian's Stage) is the first kind and
  will need a field there the day it lands.

  ⚡ **Rule 7: the gauntlet at seed 99 is byte-identical to `ab0e41a` — 79/280, rows 12 · 13 · 17 · 7
  · 9 · 7 · 14.** (Note for the record: the board reads **79/280** at `ab0e41a`, not the 80/280 that
  was current a day ago — that movement is not this branch's; a baseline worktree at the branch point
  reads 79 too.) Scavenge probe, interleaved, same 30,600 actions: 584/583 here vs 584/585 at HEAD,
  and 606 at the branch point — this branch allocates slightly LESS, because `legalTargetsFor`'s
  `'spell'` branch stopped building two intermediate arrays.

  🚧 **STILL REPORTED BY NAME, and the biggest one is a whole system somebody should take:** a
  **DELAYED triggered ability** created at resolution (CR 603.7 — "sacrifice it at the beginning of
  the next end step"). Kiki-Jiki, Twinflame, Splinter Twin, The Fire Crystal, Orthion, Jaxis, Molten
  Duplication and Mimic Vat are blocked on that one clause and nothing else. Also open: copying an
  activated/triggered ABILITY on the stack, a token that enters TAPPED, "whenever you cast a spell,
  copy THAT spell", a follow-up sentence about the token just created ("That token gains haste"), and
  an "except …" tail on a SPELL copy (Fork's "except that the copy is red").

  ✅ **RE-GATED AFTER MERGING `origin/main` at `b01cedf`** (CR 704.3 at the priority boundary,
  CR 704.5q, the CR 514.1 cleanup discard): `npm run verify` exit 0, `npm run build` exit 0,
  **4981 passed / 0 failed**, gauntlet at seed 99 STILL 79/280 with the same seven rows. The doc
  conflicts in DESIGN and this file were resolved keeping BOTH sides. And the generated pool data
  was checked BY NAME rather than by count, because that merge text-merges silently:
  `starter-cards.json`, `expanded-pool.ts` and both card indexes are strict SUPERSETS of
  `origin/main`’s — 545 → 553 with nothing of main’s dropped.

  ✅ **AND RE-GATED AGAIN after `origin/main` moved to `98488b2`** (the hidden-information
  guarantee). Two things for whoever merges this:
  1. **My DESIGN section is §3.31, not §3.30** — `fix/redaction-guarantee` published a §3.30 while
     I was out, so I moved rather than collide. Please keep both.
  2. That branch’s `packages/core/src/instance-ids.ts` is an ENFORCED table over every field of
     every event, and it broke my build until my three new events were classified. They are, and
     every id in them names an object on the STACK or the BATTLEFIELD — never a card in a hand or a
     library — which is the same fact that makes them `public` observations. ⚠️ Worth knowing: that
     table’s source scan checks a FIELD NAME across all entries, so declaring one event’s ids
     `'none'` stays GREEN if another event classifies the same name. A sabotage caught it; two
     cases now ask `instanceIdsNamedBy` per EVENT.

  verify 0, build 0, **5007 passed / 0 failed**, gauntlet seed 99 still **79/280**, same seven rows.

- 2026-08-20 worker: `fix/redaction-guarantee` 🚧 PUSHED — **the hidden-information scan recognised
  ONE key name and walked past eighteen others; the class is now closed, and the wider net found a
  third leak nobody had reported.** DESIGN §3.30.

  **What was wrong.** `collectInstanceIds` — used by the pilot feed, by `maskStateForSeat` and by the
  server's adversarial tests — collected keys named exactly `instanceId`. The engine also names cards
  under `sourceInstanceId`, `targetInstanceId`, `keptInstanceId`, `hostInstanceId`,
  `copiedInstanceId`, `appliesToInstanceId`, `source`, `target`, `targets`, `attackers`,
  `attackTargets`, `blocks`, `blocker`, `attacker`, `instanceIds`, `ref`, `attachedTo`,
  `recipientIs`, `effectTargets`. That is why the CR 514.1 `choiceAsked.sourceInstanceId` leak (fixed
  on `fix/max-hand-size-and-sba` with `NO_ASKING_OBJECT`) left the anti-cheat suite green. A key-name
  PATTERN would not have fixed it either — "ends in `InstanceId`" still misses `source`, `target`,
  `targets`, `attackers`, `blocks` and `ref`.

  **The mechanism.** `packages/core/src/instance-ids.ts` — `EVENT_ID_FIELDS`, a **mapped type over
  every FIELD of every `GameEvent`** (67 events, 187 fields). ⚠️ **If you add a field to an event, this
  file stops compiling until you classify it** — including an OPTIONAL field, which is the shape that
  hid last time. Same idiom as `OBSERVATION_POLICY` / `SOAK_EVENT_WITNESS`. The scan's key vocabulary
  is DERIVED from it, and `instance-ids.test.ts` re-derives the same set by reading core's own source,
  so an id field on a STATE type fails a test even though no event changed.

  **The third leak.** Over 300 full-pool games the wider net found `continuousEffectExpired` naming a
  card in a hidden zone (seed 3246281276, #70 Elvish Fury): a buyback spell returns to its owner's
  hand and the pump it left behind expires at CLEANUP, naming `sourceInstanceId` many actions later.
  The soak's "hidden before the window as well as after" rule is a one-window approximation and this
  walks straight through it. The scan now tracks ids that have **never once** been outside a hand or a
  library — which is what the guarantee actually promises, now written into `observation.ts`.

  **Hole 2 decided: `stackResolved` KEEPS the id.** It fires while the object is still on the stack
  (CR 405.1 / 601.2a); the move to hand is a separate `zoneChange` that is already anonymised.
  Dropping it would leave a pilot knowing less than a spectator. The old buyback EXEMPTION was
  measured over 200 games / 457k observations and could not fire — deleted, with a positive control
  that pins why.

  **Two things every other branch should know:**
  1. **`observation.test.ts` no longer uses the gauntlet decks.** It runs `runSoak` over
     mechanic-anchored generated decks with the leak scan on EVERY game, and FAILS if any mechanic the
     pool prints did not fire. If you add a mechanic and it does not fire, this file tells you.
  2. **`SOAK_LEAK_SCAN_SAMPLE_EVERY` is 1, not 31.** Measured paired in one process over the same 90
     games: 6,125 ms CPU vs 5,845 ms — ~5%. A sampled anti-cheat guarantee is not one.

  `maskStateForSeat` was checked for the same class over full-pool games (`packages/sim/masking.test.ts`)
  — **no hole**: no opponent-hand card and no library card reaches a seat or spectator view under any
  key name. `apps/server/src/security.test.ts` had a THIRD, weaker copy of the scan; it now imports
  the shared one.

  Suite 4952 passed / 0 failed (baseline 4928). Sabotage: **16 breaks, 16 caught, 0 escapes**, plus a
  control — reintroducing the CR 514.1 leak with the OLD narrow scan comes back GREEN, which is the
  direct measurement of what the widening buys.

  ⛔ **Unrelated finding, NOT fixed here, needs its own branch:** an SBA violation at **seed
  4222011655** — `#34 Blood Artist has toughness 0` — surfaced by a 450-game soak hunt. It is in
  `packages/core`'s state-based-action pass, is not a redaction bug, and does not reproduce inside the
  fast soak's game range. Reproduce with `runSoak({ mixedGames: 400, anchorAttempts:
  SOAK_MECHANIC_SEED_ATTEMPTS, baseSeed: SOAK_BASE_SEED })`.

- 2026-08-20 worker: `fix/max-hand-size-and-sba` 🚧 PUSHED — **CR 704.3 at the priority boundary,
  CR 704.5q as a real state-based action, a REVIEW of the CR 514.1 that landed while I was building
  it, and the baseline measurement nobody had published yet.**

  📊 **THE NUMBER, ISOLATED RATHER THAN ESTIMATED. CR 514.1 costs Mono-Red Aggro THREE games in 280
  on seed 99: 82/280 (29.3%) → 79/280 (28.2%)**, measured against `origin/main` at `ab0e41a`. Two
  matchups move — **Golgari Midrange 8→7** and **UW Control 16→14** — the two grindy decks, which is
  exactly where a hand-size limit should bite. It was isolated by flipping
  `RulesConfig.maximumHandSize` between 7 and 999 in the SAME build on the SAME seed, which is only
  possible because the rule is a named config value and not a literal. 👉 **Do this instead of a
  second checkout whenever the thing you changed is config.**

  📌 **Measured twice, and the delta GREW.** Against `b5752b2` the same isolation read 81/280 → 80/280
  (one game, one matchup); the token-characteristics fix then gave the grindy decks their real boards
  and it became three. **79/280 is the recorded baseline from here on** (DESIGN §3.4a and §3.29 say
  so), and this branch reproduces `origin/main` byte-for-byte on it, every matchup row equal — my own
  changes move nothing.

  🔴 **A HIDDEN-INFORMATION LEAK IN THE LANDED CR 514.1, please do not re-introduce it.** The
  discard question set `sourceInstanceId: hand[0].instanceId` — a real instance id "for the
  inspector and the wire format". `choiceAsked` carries that field **unredacted** into every pilot's
  observation feed (`packages/sim/src/observation.ts`), and instance ids are minted sequentially
  from the pre-shuffle library (`paired-arms-config.ts` pins that), so it published a read on the
  discarding player's decklist. ⚠️ **The protocol's own leak scan cannot catch this class:**
  `collectInstanceIds` only collects values under keys named `instanceId`, so anything called
  `sourceInstanceId`, `targetInstanceId` or `keptInstanceId` walks straight past it. Fixed with
  `NO_ASKING_OBJECT` (a named sentinel in `choices.ts`) — **use that for any question a GAME RULE
  asks**, never a card that happens to be lying around.

  ⚠️ **CR 514.3a was half-implemented and now is not.** The landed version kept the turn open for a
  madness window (right) and then ended the turn (wrong): the rule says **another cleanup step
  begins**. It is now re-entrant and needs no new state field — reaching the turn machine's step
  advance *while the step is still cleanup* can only mean a priority window was opened during it. It
  had NO test until the sabotage pass said so; it does now.

  ⚡ **RULE 7, AND THE TRAP THIS BOX SETS.** The CR 704.3 check goes on the hottest loop the sim has
  — a 280-game gauntlet passes priority **125,753 times**. My first cross-build gauntlet
  comparisons read **1.02× to 1.41×** for a change that allocates nothing; that was the box, not the
  code, and I nearly redesigned around it. What the three real measurements say: **scavenge counts
  587/584 vs 588/583** (inside `scavenge-probe.ts`'s ±2 floor — it allocates nothing), **paired CPU
  with BOTH ENGINES IN ONE PROCESS, 9 interleaved rounds, min-of-N: 2157 ms vs 2156 ms = 1.0005×**,
  and a direct bench (`packages/core/bench/sba-gate-cost.ts`) at **~30 ns per permanent**. 👉 **Two
  builds in one process beats two checkouts** — import a patched copy of `packages/core/src` and
  alternate the arms; compare the self-play digests first so the workload is proved identical.

  🔑 **The gate is affordable because of ONE piece of reasoning, and it is worth reusing:**
  `PermanentModification` is **purely additive** (the rules manifest proves it at compile time), so
  a modifier that can only ADD toughness cannot kill a creature — it can only keep one alive. A
  board whose modifiers are all positive can therefore be judged on printed base plus counters. Only
  a SHRINKING modifier sends the board to the full check. Pass rate **6.3% → 0.1%** of those 125,753
  passes. ⚠️ If anyone ever adds a value-SETTING modification, that reasoning dies with the
  manifest's proof — the two go together.

  🧮 **CR 704.5q WAS reachable, contrary to the register.** PERSIST returns a creature carrying a
  `-1/-1` counter without going near `addCounters`, and it wrote a **negative `+1/+1` tally** — so
  nothing could ask "does it have a -1/-1 counter on it?", which is persist's own printed condition.
  The rule now lives in the SBA pass and the primitive no longer does it at all (one implementation
  of one rule); persist writes a real `-1/-1` counter.

  ⛔ **CR 704.5b (a spell-driven draw from an empty library does not lose the game) is DEFERRED by
  decision.** It ends games earlier and moves the gauntlet baselines again; measuring it in the same
  branch as CR 514.1 would give one number attributable to neither. It stays registered as
  `spell-draw-decking` and now has a matrix cell citing it. Whoever takes it should isolate it the
  same way and re-publish the baseline.

  🧪 **Sabotage-checked: 11 breaks, 11 caught, 0 escapes.** The one that first came back GREEN was
  the useful result (CR 514.3a, above). The conformance manifest moves **402, 514 and 704 from gap
  to covered** (6 gaps → 4: 613, 615, 616, 707), the interaction matrix's `cda x turnfacts` cell
  moves gap → covered, and its GAP register learned a `closedBy` field so a closed entry can stay as
  the record without being counted as outstanding.

  🧹 Converged on `origin/main`'s idiom rather than adding a second one: main made each test file's
  local `pass` choice-aware, so my shared `passOrAnswer` helper is gone. Same for the clone's
  optional-key handling — main always writes the key, which is the better fix, so my `sortedJson`
  workaround in `selfplay-lock.test.ts` is gone too.

  ⚠️ **Timing note for whoever merges:** this branch merged `origin/main` at `b5752b2`. It touches
  `engine.ts`, `internal/sba.ts` and `internal/clone.ts`, so it conflicts with anything else in
  those files — but everything it adds to the cleanup step is layered ON TOP of main's
  implementation, not a second copy of it.- 2026-08-20 worker: `fix/token-characteristics` 🚧 PUSHED — **every token in the game was entering
  COLOURLESS, with no creature type, and not knowing it was a token.** `makeToken` built a
  `CardDefinition` with a name and a P/T and nothing else, `colorsOfDefinition` reads colour off cost
  PIPS, and a token has no mana cost — so "a 1/1 **black** Faerie Rogue creature token" and "a 5/5
  **red** Dragon token" both arrived invisible to a coloured anthem, to protection from a colour, to
  "destroy target nonblack creature", to every typal lord and to every `CardFilter.anyOfColors` query.
  The cards compiled `'complete'`, the tests passed, and the token then played as a different object
  from the one printed. **Every token card in the pool had it**, and it predates all recent work.

  **Measured, paired, same cached 2100-card corpus, against the `origin/main` this merges into: 533
  → 545 playable (25.4% → 26.0%), +12 cards, 0 regressions** — I diffed the two full playable SETS,
  not just the counts. The shipped pool is **545** cards (main's 42 candidate groups plus mine,
  REGENERATED rather than text-merged; see below).

  🎨 **WHAT A TOKEN LOSES NOW: nothing it is printed with.** `CardDefinition.colors` (the colour
  stated in WORDS), `subtypes` (its creature types), `types` ("artifact creature token"), `keywords`,
  and `isToken`. Two details worth copying rather than re-deriving:
  1. **`colorsOfDefinition` PREFERS the explicit field and falls back to pips**, so every printed card
     still walks its cost exactly as before — nothing that worked changes. An **empty array is
     meaningful**: `[]` is the printed word "colorless", absent means "read my pips". Do not merge the
     two sources; the words win, and that is what devoid and colour indicators need too.
  2. **CR 111.3 names a token by its subtype LINE** ("Faerie Rogue"), not by the last word of it. The
     old rule took the last word, so two different tokens could share a name.

  🧬 **`isToken` IS ON THE DEFINITION, beside `isEmblem` — and that is the interesting part.** A token
  definition is MINTED by the effect that creates it and is never shared with a card, and
  `cloneInstance` shares `def` **BY REFERENCE** — so the flag **cannot be dropped by the field-by-field
  clone that has now silently lost four fields on this project** (`awaitingTargets`, `xValue`,
  `printedDef`, `chosenAsEntered`). There is no line to forget. `internal/clone.ts` needed no new line
  and now SAYS SO, with the rule spelled out for the next branch: put a fact on the DEFINITION when it
  is about the card, on the instance only when it is genuinely per-object state — and then add it with
  its own conditional AND its own test. `packages/core/src/token-clone.test.ts` pins both halves,
  including that the ordinary cloned instance is still exactly the ten-property object it always was.

  ⚰️ **CR 704.5d SHIPS: a token that has left the battlefield ceases to exist.** Applied by BOTH
  leave-the-battlefield funnels — core's `moveToZone` and the cards package's `movePermanentTo` —
  through one shared `ceaseToExistIfToken`, because a rule implemented in one funnel and not the other
  is a rule that depends on which primitive killed the creature. It runs **after** the `zoneChange`
  event, so every "dies" trigger still fires exactly as it does for a card. Done at the MOVE, not as an
  SBA pass: the SBA form would walk both graveyards, exiles, hands and libraries after every
  resolution, every draw and every combat-damage step looking for something nearly never there.
  Without it a dead token sat in a graveyard for the rest of the game, inflating every graveyard count
  the engine derives and standing as a legal target for anything returning a creature CARD.

  🔍 **A SECOND COLOUR READER, found on the way — worth knowing about because the shape recurs.**
  `passesDestroyFilter` (Doom Blade's `nonblack`) walked `def.cost` **itself** instead of asking
  `colorsOfDefinition`. That second opinion was wrong twice: it could not see a HYBRID pip, and it
  could not see a printed colour with no cost behind it. **If you need a card's colour, call
  `colorsOfDefinition`. There is now exactly one reader.**

  🧷 **REUSED, NOT RENAMED.** `colors` is the name `data-tools` already uses for a card's printed
  colours; `isToken` mirrors `isEmblem`; `CardFilter.isToken` is one tri-state for BOTH printed words
  ("token" / "nontoken") rather than two fields that could disagree; the typal anthem reads the
  existing closed `SEARCHABLE_SUBTYPES` table (now documented as the compiler's subtype vocabulary
  generally, not only a search's) and the existing instance-aware `permanentHasSubtype` from
  `feat/as-enters-choices`.

  🃏 **CARDS UN-REPORTED (23 joined the pool):** Bitterblossom, **Bitterbloom Bearer** (the two-colour
  "blue and black" token) and Ophiomancer — the three the step-trigger branch left reporting
  *specifically* because of this — plus Goblin Chieftain, Lyra Dawnbringer, Diregraf Captain, Blood
  Artist, Falkenrath Noble, Hornet Queen, Seraph Sanctuary, Harvester of Souls, Soul of the Harvest,
  Bad Moon, Crusade, Adaptive Automaton, Paladin en-Vec, Third Path Iconoclast and more token makers
  across colours. Three compiler extensions were needed and each is small: a **typal anthem** noun
  (both printed shapes; the bare "Goblins you control" adds NO card type, because a Kindred
  Enchantment genuinely IS a Faerie without being a creature), the **Kindred card type** (CR 308, with
  its graveyard type bit), and an **"A and B" trigger body** — accepted only when BOTH halves are
  complete rules of their own, which is what makes splitting on a word safe (cutting "1/1 **blue and
  black** Faerie" leaves "create a 1/1 blue", which matches nothing, so that cut is abandoned).

  🧪 **13/13 SABOTAGES RED, and the first pass is the part worth reading: 3 of 10 SURVIVED.** Each
  survivor named a real gap rather than a flaky test:
  - the token-face REFUSAL branches were never exercised — my two refusal cases failed the *pattern*,
    not `parseTokenFace`. Two descriptors that actually reach it now do.
  - the typal anthem was pinned only through GENERATED pool data, so breaking the RULE changed
    nothing. **If your test plays a pool card, it does not test the compiler.** Both layers are pinned
    now.
  - `CardFilter.isToken` had **no consumer at all** — an inert field, which this project's contract
    forbids. The enters/dies trigger rule now reads the printed word, which brings Harvester of Souls
    and Soul of the Harvest into the pool and makes the filter load-bearing.

  ⚠️ **A DATA-PIPELINE BUG THIS EXPOSED, which will bite anyone who regenerates the pool:
  `fetchCardsByNames` cannot resolve a TWO-FACED name.** Regenerating after `feat/split-cards` landed
  brought modal DFCs into the pool for the first time, and their printed names carry `//`, which
  Scryfall's collection endpoint will not accept as an exact name. Every one of them reported
  "unresolved" and fell straight back out of the committed card index, taking its art and its display
  row with it — and it surfaced as five unrelated-looking test failures. Fixed by asking for the FRONT
  half, which returns the whole card. **Modal DFCs are consequently REPRESENTED in the pool now** and
  have left `pool-mechanics.test.ts`'s unrepresentable list.

  ⚡ **Rule 7, measured properly.** Wall clock on this box is worthless — the SAME build measured
  1422 ms and 1907 ms ten minutes apart. Paired `process.cpuUsage`, min-of-5 over the same in-process
  gauntlet (Mono-Red Aggro, 40 games, seed 99), the two measured back to back: branch **1875 ms** vs
  main **1844 ms** (1.02x), inside that spread — and an earlier interleaved A/B/A had the branch
  FASTER than main (1422 vs 1578 ms), which is what "inside the spread" means. Deterministic gauntlet
  output is **identical in six of seven matchup rows**; UW Control moves 15/40 → 14/40. That single
  game is a REAL behaviour change, not noise: the hero deck runs Young Pyromancer, and its Elemental
  tokens are now red Elementals that cease to exist when they die instead of piling up in a graveyard
  the evaluator reads.

  ⚠ **GENERATED DATA MUST BE REGENERATED ACROSS A MERGE, NEVER TEXT-MERGED — and git will not tell
  you.** Merging a main that had re-run the pool generator produced an `expansion-candidates.json`
  carrying MY 30 groups and none of main's 42, with **no conflict reported**, and the same for
  `expanded-pool.ts` and both card indexes. It looked like a clean merge and would have silently
  reverted ~150 pool cards. What works: take main's generated files WHOLESALE
  (`git checkout origin/main -- <them>`), re-append your own candidate group, then re-run
  `build-expansion.ts --fetch`, its emit pass, `npm run fetch -w @jonny-boi/data-tools` and
  `apps/web/scripts/build-card-index.mjs`. A textual merge of two generator runs is not what either
  run would have produced. **Check `git diff origin/main --stat -- packages/cards/data` after every
  merge.**

  ⚠ **THE SOAK FOUND A REAL DEFECT IN ITSELF on the wider pool, and it is fixed here.** Its leak scan
  buffers observations and tests them against the POST-action state, which reports the mirror image of
  the buyback false positive its own comment describes: a creature dies (public `creatureDied`, naming
  it — the whole table saw it), then Gravedigger returns it from the graveyard to a HAND later in the
  same window, and the honest observation is reported as a leak. An id is only a leak when it was
  hidden BEFORE the window as well as after — which is exactly "the table never saw this card". A
  DRAWN card is hidden on both sides and is still scanned. Sabotage-checked: making `drawCard` public
  still reports it.

  📌 **Two existing REFUSAL tests flipped to assert what ships**, because they were documentation of
  exactly the gap this branch closed: `counters-templates.test.ts`'s "REFUSES the nontoken variant —
  instances carry no token flag", and `you-may-and-triggers.test.ts`'s tutor refusal, which used
  "Zombie" as its out-of-table subtype (Zombie joined the table with the typal lords; the refusal is
  now shown with Kavu, and the rule under test is unchanged).

  ⛔ **REPORTED BY NAME, never approximated:** **token COPIES** ("create a token that's a copy of
  target creature"). Copy effects LANDED while this branch was in flight, so the missing half is now
  only the token-copy PRIMITIVE — a rule that picks a source and hands `copyResultDef` to
  `ctx.createToken`. **The trap is already disarmed**: core stamps token-ness in `createTokenInState`,
  so a copy built from `copiableDefOf` (which returns the copied CARD and carries no token flag) is
  still a token, ceases to exist, and answers the nontoken filters. Also: the predefined artifact tokens (Treasure/Clue/Food — no P/T in the clause
  and an activated ability the rule does not build), a token that enters TAPPED or ATTACKING
  (`createToken` cannot express either), a DERIVED token count ("create X 1/1 Goblins, where X is
  Krenko's power"), and "Destroy all nontoken creatures" — which is a `destroyAll` gap (it takes no
  `CardFilter` at all), not a token one.

  Files owned: `packages/core` (`card.ts`, `choices.ts`, `events.ts`, `index.ts`, `derived.ts`,
  `internal/zones.ts`, `internal/clone.ts` comment-only, NEW `token-clone.test.ts`), `packages/cards`
  (`primitives.ts`, `effect-helpers.ts`, `compile/rules.ts`, `compile/compile.ts`, `data/pool.ts`,
  regenerated `data/expanded-pool.ts` + `data/expansion-report.json` + `data/expansion-candidates.json`,
  NEW `token-characteristics.test.ts`, plus `pool.test.ts` / `pool-mechanics.test.ts` /
  `counters-templates.test.ts` / `compile/you-may-and-triggers.test.ts`), `packages/data-tools`
  (`src/client.ts` + regenerated `data/`), `packages/sim/src/observation.ts` (one classification),
  `apps/web` (`src/lib/about/mechanics.ts` + regenerated `src/data/card-index.json`), DESIGN §3.29,
  COORDINATION.md.
- 2026-08-20 worker: `feat/pool-expansion-2` 🚧 PUSHED — **the shipped pool is 357 → 530 cards, and
  every one of the eleven blind mechanics now prints a card a player can see without importing a
  decklist.** Pool + fetch pipeline only: **no compiler rule, no engine change, and NO meta deck
  touched**. Gauntlet seed 99 is **byte-identical** to the same-box `origin/main` this branch merged
  (`b5752b2`): **80/280**, rows 12·13·17·7·9·7·15, every one equal.
  ⚠️ **The recorded 81/280 is now 80/280 and that game is NOT mine** — a baseline worktree at
  `b5752b2` with no pool change reads 80/280 as well, so it belongs to
  `feat/block-requirements-and-statics`. Whoever re-records §3.4a should use 80/280.

  🔑 **THE THING TO KNOW: three of the eleven were blocked in the FETCH PATH, not by the compiler.**
  Every sibling branch signed off with "whoever next runs the pipeline gets these free." They were
  not free — re-running the old pipeline would have produced almost none of them.
  1. **`/cards/collection` does NOT resolve a combined `"A // B"` name.** `{ name: 'Fire // Ice' }`
     comes back in `not_found`; `{ name: 'Fire' }` returns the whole `Fire // Ice` record. Every
     split and aftermath candidate had been failing to resolve, silently, for as long as the list had
     them. **`frontFaceName` (data-tools `verify.ts`) is now the ONE place that answer lives** — the
     expansion fetch and the regenerated `starter-cards.json` both go through it. The starter list is
     a list of things to ASK SCRYFALL FOR, so it carries front-face names; the index keeps the card's
     real name and `invariants.test.ts` already matches either half.
  2. **A Siege's printed defense is on `card_faces[0].defense`, not at the card level.**
     `Invasion of Gobakhan` reports `defense: undefined` on the card and `'3'` on the battle face.
     Capturing the field was not enough — every battle in Magic normalized to `null` anyway, which is
     why "a re-fetch unblocks battles" turned out to be false. The same front-face fallback now
     covers `loyalty` (a transforming walker prints its number on a face too). **This is the third
     time a missing normalizer field has masqueraded as a compiler gap** (after `layout`): if you are
     measuring coverage, check the normalizer is not dropping the field your detector reads.
  3. **CR 715.2 — an ADVENTURER's mana cost is the CREATURE's, not the two halves summed.** Scryfall
     prints `"{B} // {2}{B}"` and reports `cmc: 1`; summing it produced a cost that contradicted the
     card's own mana value and tripped the index's pip↔mana-value invariant on all eighteen
     adventurers at once. A SPLIT card is the opposite (CR 709.4 — the sum IS the cost, and Scryfall's
     `cmc` agrees), so the fix is narrowed to that one layout.

  ✅ **Newly visible, per mechanic (before → after):** split 0→5 · aftermath 0→3 · adventure 0→18 ·
  modal DFCs 0→21 (the ten Pathways + eleven spell//land halves) · as-enters naming 0→8 · mandatory
  additional costs 0→9 · two-destination search 0→2 (Cultivate, Kodama's Reach) · **the mana-ability
  model 0→50** (ten pain lands, ten filter lands, ten Talismans, ten Signets, Mox Opal, Ancient Tomb,
  Reflecting Pool…) · battles 0→3 (Invasion of Moag / Belenon / Dominaria) · intervening "if" 0→3 ·
  step triggers 1→12 · **equipment with a TRIGGERED ability 0→4** (Sword of Fire and Ice, Skullclamp,
  Sword of the Animist, Argentum Armor) · **damage prevention 0→4** (Fog, Holy Day, Darkness,
  Moment's Peace) · **replacement effects 0→2** (Hardened Scales, Torbran).
  `pool-mechanics.test.ts` went from 22 inventory entries + 11 play tests to **35 + 26** — every one
  of those mechanics is now PLAYED in a seeded game, not merely present in the data.

  📌 **The last three rows are yours, `feat/replacement-effects` and `feat/combat-damage-and-equipment`.**
  Re-running the SAME candidate list on the merged compiler admitted fifteen more cards with no edit
  at all. That is the argument for running this pipeline after every compiler branch rather than once
  every four merges — the generator's output is committed, so a compiler that got smarter is
  invisible until someone re-runs it.

  ⛔ **Still no honest card — only two left, both measured against every printed card carrying the
  mechanic:** **multikicker 0/19** (12 blocked on the counters template alone) and **emblems 0/90**
  (the loyalty ULTIMATE is the bigger blocker — 108 unreadable loyalty clauses against 77 unreadable
  emblem bodies). Other measured counts for whoever picks up a template family: battles **3/36**,
  modal DFCs **22/98**, split **5/124** (28 Rooms, 17 FUSE), aftermath **3/27**, adventure **18/152**,
  prevention **11/123**, equipment-with-a-trigger **13/145**, replacement-on-counters **3/17**,
  replacement-on-damage **4/32**.

  🃏 **Cards that would be GAUNTLET-WORTHY and were deliberately left out** (adding one moves every
  recorded A/B verdict — a separate, measured decision, and not a pool run's to make): the ten
  **Signets**, ten **Talismans** and ten **pain lands** (a real mana base for all seven two-colour
  gauntlet decks), **Cultivate / Kodama's Reach / Birds of Paradise / Sylvan Caryatid** (Mono-Green
  Ramp's actual ramp package), **Village Rites / Thrill of Possibility** (Rakdos Goblins card flow),
  **Corpse Knight / Marauding Blight-Priest / Kambal** (Orzhov Lifegain's drain payoff),
  **Poison-Tip Archer / Elas il-Kor** (Golgari Midrange), **Skullclamp / Sword of Fire and Ice /
  Lightning Greaves** (aggro equipment), **Fog** (a real answer for Mono-Green), and **Foulmire
  Knight / Rimrock Knight** (two-for-one adventure bodies).

  🐞 **THREE DEFECTS THE BIGGER POOL FOUND, NONE OF THEM IN THE POOL.** `test/full-pool-soak` builds
  its theme decks FROM the shipped pool, so tripling the pool is also a much wider soak — and it broke
  three ways, all pre-existing, all invisible while the pool had no card that could reach them.
  1. **The pilot proposed a spell it could not cast, and then proposed it again forever.**
     `scoredSpellGoals` gated on land/timing/mana/targets but not on a MANDATORY additional cost, so
     Altar's Reap with an empty board became a `castSpell` the engine rejected — and, since nothing
     about the board changed, the same cast on the next priority, and the next. Three soak games
     burned the 6000-action cap without ending. Now filtered at that function's ONE exit through
     core's own **`unpayableAdditionalCostReason`** (newly exported from `@jonny-boi/core` for
     exactly this), so both consumers inherit it and there is still one reader of the rule.
     ⚠️ **If you add a pilot path that builds its own cast action, it needs this gate too.**
  2. **A FREE equip cost was an infinite loop.** `bestEquipHost` excludes the current host, which
     stops re-equipping the same body — but with two hosts and Equip {0} the pilot moved the
     Equipment A→B, found A was again the best non-host, and moved it back, forever, at no cost.
     `equipIsAnUpgrade` now requires the destination to STRICTLY beat the host it is on. Lightning
     Greaves was in all three capped games.
  3. **The soak's own `transform-dfc` predicate was `hasKey('backFace')`** — and four layouts hang a
     second half off that field (split, aftermath, adventure, modal DFC), none of which transforms.
     The theme deck for the mechanic was drafted almost entirely from cards that cannot flip and the
     soak reported it INERT while Delver of Secrets was never dealt in. Narrowed to "a back face that
     is not separately castable". It did not start wrong; it BECAME wrong when the pool grew.

  📊 **Corpus coverage does not move: 533/2100 (25.4%) on `origin/main` at `b5752b2` and 533/2100
  here**, measured in two worktrees on the same box — and 524/524 against the earlier `78e3299`, so
  the claim has now held across two baselines. This branch adds no compiler rule.

  ⚠️ Three stale-guard fixes fell out, all worth knowing: `expanded-pool.test.ts`'s "no mana source
  taps for more than 2" now takes an exception list BY NAME (Gilded Lotus and Thran Dynamo genuinely
  print three) rather than a raised ceiling, because raising the number would have retired the guard;
  `attachment-cards-in-pool.test.ts` gained seven rows AND now expands a LIST-valued keyword one entry
  per value, so a Sword of Fire and Ice granting protection from the wrong colour fails instead of
  passing on the bare keyword name; and `pool.test.ts`'s pool-size constants moved 325 → 498 compiled.

- 2026-08-20 worker: `test/interaction-matrix` 🚧 PUSHED — **the interactions between the
  shipped systems are now an executable matrix, and finding three real defects took nine
  pair suites.** **300 cells** — every unordered pair of **25 systems**, stated exactly
  once: **49 covered here · 9 covered by an existing suite · 1 GAP cell · 96
  not-applicable · 145 untested-and-said-so.** `packages/cards/src/interaction/interaction-matrix.test.ts`
  holds the table and ENFORCES it — a covered cell must name a test file that exists, a
  gap must carry a CR reference and a reproduction, an n/a must carry a reason, and every
  system must resolve a witness core still exports. **Adding a system fails the
  completeness test until you say what it does to every system already there.**

  ⚠️ **DEFECT 1, FIXED — a granted keyword was invisible to targeting, protection and
  ward, and it is reachable with a card the app ships.** `isTargetableBy`,
  `effectiveProtectionOf` and `effectiveWardOf` all took their fast path on
  `state.continuous.length === 0`. That list holds ONLY until-end-of-turn effects; layer 3
  — an Aura or Equipment's grant to its host, an anthem, an emblem from the command zone —
  is DERIVED from the battlefield and puts nothing in it. So every layer-3 grant of
  hexproof, shroud, protection or ward read as ABSENT. **Mask of Avacyn ("equipped creature
  … has hexproof") did not stop an opponent's Lightning Bolt.** A statically granted ward
  was never charged, and an Aura that gained protection from its own colour never fell off
  (CR 704.5m). One shared gate now answers "can anything modify a keyword right now?"
  (`anyContinuousModification`, allocation-free, short-circuits on the first source), and
  `legalTargetsFor` builds the index ONCE for the whole menu where it used to rebuild it
  per candidate — so the fix is a net *reduction* on that path.
  👉 **If you write a fast path over keywords, gate it on that helper, never on
  `state.continuous.length`.**

  ⚠️ **DEFECT 2, FIXED — there are TWO zone-change funnels and the second had drifted.**
  Core's `moveToZone` + `resetInstanceForNewZone`, and the cards package's
  `movePermanentTo` (every bounce, every put-into-graveyard primitive). The second
  hand-copied the reset list and was missing **three** of the eight fields, so WHICH funnel
  bounced a permanent decided what it remembered: a bounced **Aura/Equipment came back
  still pointing at its old host**, a bounced **planeswalker could not activate the turn it
  was replayed**, and a bounced **as-enters lord still lorded over the type it named last
  time** (CR 400.7). `movePermanentTo` now CALLS the shared reset; core exports it. Each
  system's own author tested their reset through CORE's funnel, which is exactly right and
  exactly why nobody saw it.

  ⛔ **THREE GAPS RECORDED, NOT FIXED** — each with a CR reference and a reproduction that
  asserts the honest current behaviour (green today, RED the day it is fixed). Full detail
  in the file's GAP register.
  1. **`sba-on-priority` (CR 704.3)** — state-based actions are NEVER checked when a player
     would RECEIVE priority. `onPassPriority`, `advanceToStepWithPriority` and
     `grantPriority` do not call `checkStateBasedActions`; it runs only after a resolution,
     after combat damage, after the draw step and at cleanup. Reachable with two shipped
     cards: put 3 damage on a Tarmogoyf that is a 3/4, then flash back the graveyard's only
     SORCERY — the card moves to the stack as part of casting it, the star box shrinks to
     2/3, and the creature stands there with lethal damage while the opponent takes
     priority to respond. **Not fixed here because the honest fix adds an SBA pass to the
     hottest loop and needs a paired CPU-time measurement** (wall clock on this box is
     worthless — the same build reads 39–87 games/sec within an hour).
  2. **`spell-draw-decking` (CR 704.5b)** — a SPELL-driven draw from an empty library does
     not lose the game. Core's `drawCard` calls `loseGame`; the cards package's `drawCards`
     primitive returns early ("emit nothing rather than fabricate a loss event here"). A
     player at zero cards may cast Opt forever. It matters to the LAB specifically: a
     control deck that has decked itself keeps playing, biasing exactly the long games a
     control matchup is decided in. **Not fixed here because it can end games earlier,
     which moves the recorded gauntlet baselines several branches pin.**
  3. **`counter-annihilation-is-not-an-sba` (CR 704.5q)** — +1/+1 and −1/−1 counters
     annihilate inside the `addCounters` primitive rather than in the SBA pass, so two
     kinds arriving by two different routes coexist. Unreachable by any printed card today;
     recorded as the placement argument for whoever adds the second counter route
     (persist, a −1/−1 ETB replacement, proliferate).

  📌 **A finding for whoever owns the pool: SEVEN shipped systems have NO card a player can
  see** — the mana-ability model (riders/restrictions/derived colours), step triggers +
  the intervening "if", split/aftermath/adventure cards, as-enters choices, mandatory
  additional costs, replacement/prevention effects, and copy effects. `pool-mechanics.test.ts` names four *other* unrepresentable systems
  with reasons; these five are in neither list. DESIGN §3.20's own rule is that a feature
  nobody can see is not done. (Not my file to edit — reporting it.)

  ⚠️ **DEFECT 3, FIXED — `origin/main` did not compile.** `feat/replacement-effects` added
  two `GameEvent` kinds and `test/full-pool-soak`'s exhaustive `SOAK_EVENT_WITNESS` map was
  merged without them. That map is DESIGNED to stop compiling until somebody answers the
  question, so it worked exactly as intended and the merge answered nothing. Caught by
  `npm run build` — **`npx vitest run` was green the whole time**, which is TESTING.md's own
  warning about the second gate, demonstrated. The file's owner has since fixed it upstream
  and I dropped my duplicate; flagging it because two branches merged in the same hour can
  break a gate every other worker then hits.

  📌 **The `sba-on-priority` GAP has NARROWED, and that is the matrix working.** A sibling
  closed the announcement half (`applyCastSpell` now runs the pass, CR 704.3) — my
  reproduction went RED, which is the signal it was designed to give, and the cell is now a
  POSITIVE test. The priority-pass and step-advance halves still stand and keep their own
  reproduction.

  📌 **Sabotage-checked: 22 deliberate rule breaks, each run against the whole suite; 22
  went RED, none stayed green.** The discipline is the point — a cell that stays green when
  you delete the rule it names is not a test.

  GATE: `npx vitest run` 0 failed · `npm run verify` exit 0 · `npm run build` exit 0, all
  after merging `origin/main` **three times mid-flight** — the fourth wave (step triggers,
  split cards, as-enters, additional costs), then replacement effects, then copy effects.
  Each merge ADDED cells rather than invalidating them: 19 → 23 → 24 → **25 systems**,
  171 → 253 → 276 → **300 cells**. Doc conflicts resolved keeping BOTH sides.
- 2026-08-20 worker (`feat/mana-spend-restrictions`): ⚠️ **`origin/main` at a6419e5 DOES NOT
  COMPILE, and it is not one branch's fault — it is two that never met.** `npm run build` fails in
  `packages/sim/src/soak-config.ts`: `SOAK_EVENT_WITNESS` is a mapped type over `GameEvent['type']`,
  and the replacement-effects work added `replacementApplied`/`replacementExpired` to that union
  while the soak table arrived from a different branch. Neither is wrong; the merge simply was not
  built. I verified it on a clean `origin/main` worktree before touching anything, so this is not my
  branch's doing — but my branch cannot gate on a red base, so I classified both as `null` with a
  comment saying so, and the replacement branch should decide whether they deserve a real
  `SoakMechanicId`.

  **This is the third time on this branch that a green test suite hid a red build**, so it is worth
  saying plainly: **Vitest strips types without checking them.** `npx vitest run` passed 3,857 tests
  on a tree whose `tsc` was failing. Only `npm run build` (and therefore `npm run verify`) sees it.
  If you merge, build.

- 2026-08-20 worker: `feat/mana-spend-restrictions` 🚧 PUSHED — **the fifth mana shape is real:
  the POOL carries the spend restriction.** `feat/mana-ability-model` shipped four shapes and
  reported this one by name with an analysis of why it was different; that analysis was right, and
  this is the answer to it.

  **Measured on the cached 2100-card corpus, same command, against the MATCHED `origin/main`
  (a6419e5, both worktrees rebuilt): 510 → 516 playable, +6, 0 regressions.** (The same +6 measured
  485 → 491 against the previous base a few merges earlier — the delta is the branch's, not the
  base's.) The six: Ancient
  Ziggurat, Somberwald Sage, Eldrazi Temple, Maelstrom of the Spirit Dragon, **Unclaimed Territory
  and Secluded Courtyard**. The 15-card "spend restriction" gap is GONE, and what remains of it is
  three residuals that are each a different system and now say so. Whoever re-runs the audit will
  see the mana family shrink — that is the fix, not a regression.

  🤝 **THE LAST TWO ARE A JOINT WIN WITH `feat/as-enters-choices`, and I used their seam rather
  than coining a second one.** "Spend this mana only to cast a creature spell **of the chosen type**"
  is two halves: naming the type as the land enters (theirs — `CardInstance.chosenAsEntered`) and
  restricting the mana (mine). The clause on the shared definition is a DECLARATION
  (`ManaSpendClause.subtypeChosenBySource`); `resolveSpendRestriction` substitutes the permanent's
  own stored value at the moment the mana is MADE, so the pool only ever holds CONCRETE restrictions
  and no payment path ever looks a permanent up. Cavern of Souls itself still reports — but now only
  for "and that spell can't be countered", which is a real unimplemented rules effect that also
  blocks 15 other cards, and nothing to do with mana.
  ⚠️ A permanent that named NOTHING makes mana that pays for NOTHING, never for everything, and the
  compiler REFUSES the clause on a card whose text never names a type. Mana that can never be spent
  is as much a lie as mana that pays for anything; the difference is only which direction the lie
  flatters the deck.

  ⚡ **THE POOL REPRESENTATION, and why it is totals-inclusive.** `ManaPool` is now
  `Record<ManaColor, number> & { restricted?: readonly RestrictedMana[] }`, where `pool[color]` stays
  the TOTAL with restricted mana INCLUDED and the parcels record which slice is not freely
  spendable. Everything that asks "how much mana is floating" — `poolTotal`, the seat panel, the
  replay format, the end-of-step empty — is asking about QUANTITY, and a restriction does not change
  quantity. Only LEGALITY changes, and every legality question already funnels through
  `canPay`/`payCost`. **`restricted` is ABSENT (not an empty array) on every ordinary pool**, and all
  three of `canPay`, `payCost` and `planManaPayment` short-circuit on that `undefined` before doing
  anything else — same discipline as `manaExtrasOf`. Do not normalise it.

  🧮 **IT IS NOT A MATCHING PROBLEM, and that is the whole design.** One `payCost` call funds ONE
  thing, so every pip in it shares the same purpose and each mana is either usable for the whole
  payment or for none of it. Hide what the purpose may not touch, run the existing algorithm on
  what is left. Linear in the parcel count, no search, and the same algorithm — so no second opinion
  about hybrid symbols or generic pips. A restriction is DATA (a disjunction of clauses over
  purpose/types/subtypes/colour/legendary), never a per-card branch.

  ⚠️ **THE BUG THAT WILL BITE THE NEXT PERSON, because it bit me and the pilot tests caught it.**
  `spendPurposeIfRestricted(pool, def, kind)` asks the pool AS IT IS NOW, and that is correct for
  `canPay`/`payCost` — but WRONG for `planManaPayment`, which runs before the mana exists. Gating on
  the live (empty) pool gave the planner no purpose to check the restriction it was about to create
  against, so it refused to tap Ancient Ziggurat at all and the pilot read a castable creature as
  uncastable. **The planner therefore takes the card DEFINITION plus a kind and resolves the purpose
  LAZILY**, at the two places that actually read it. An ordinary board pays two unread arguments.

  🧠 **THE AI SPENDS IT FIRST.** Restricted mana is the least flexible resource on the board, and
  the planner's existing "least flexible source first" tie-break could not see that — `flexibility`
  counts COLOURS, and Ancient Ziggurat offers five, so it ranked LAST. A `restrictedRank` term joins
  the same ordering, below `pain` (least-flexible must never outrank does-not-kill-me).
  `packages/ai/src/spend-restriction-pilot.test.ts` drives the real heuristic pilot through both
  directions: it casts a creature off a lone Ziggurat, and it does NOT tap that Ziggurat toward a
  burn spell (the failure there is not "it passes" — it is tapping out and being rejected).

  📊 **PERFORMANCE, re-measured after each merge against a separate `origin/main` worktree on
  this box, never wall clock.** Against the final base (a6419e5): gauntlet
  `Mono-Red Aggro --games 40 --seed 99` is **81/280 on both, every matchup row equal**; self-play
  scavenge counts over 40 seeded games are **578/562 (branch) vs 577/564 (main)** with an identical
  **29,899 actions** both sides — the same games, the same garbage; paired `process.cpuUsage` user
  time over 6 alternating pairs is **0.999 at the min, 1.028 at the median, 1.006 at the mean**.
  Against the previous base (068be3d) the same three gates read 81/280, 577/563 vs 576/561, and
  0.880 / 1.000 / 0.972 over 8 pairs. Parity on both, measured twice.
  ⚠️ **The brief for this branch quoted the gauntlet gate as 79/280.** That figure is
  `feat/mana-ability-model`'s, measured on ITS base; `origin/main` reads **81/280** on this box, and
  has done across every base I measured. Measure your own base before treating a number in a brief
  as a gate.

  ⚠️ **A trap for anyone adding a field to a state object.** `serializeState` is hashed by
  `selfplay-lock.test.ts` to prove a refactor did not change the game. Adding `manaRestricted`
  unconditionally moved all 24 golden STATE digests while the event-log digests stayed
  byte-identical — a false alarm that reads exactly like a rules regression, in the one test whose
  job is to tell them apart. The field is now OMITTED when zero, and the goldens are untouched.
  (Also fixed in passing: `primitives.addMana` tested `sym in pool`, which would have been true for
  the new `restricted` key.)

  ⛔ **THE COMMANDER IS REFUSED, DELIBERATELY, and the family it was lumped with is not one family.**
  The audit reported 8 cards as "a colour derived from an object this engine has no concept of (a
  commander, or a remembered permanent)". Those are two different jobs and the shared name hid it.
  Split, and both now report accurately:
    - **2 cards** (Command Tower, Arcane Signet) need a **commander's colour identity** — a
      commander, a command zone holding one, and a format that has both. None exist here. A fake
      commander would silently set those cards' output in every game the lab plays, corrupting the
      A/B verdicts they appear in. I also did NOT build the general seam ("colours derived from a
      named object the engine tracks"): with one hypothetical consumer it is a guess at an
      interface, and the other six cards turned out not to need it at all.
    - **6 cards** (Mirari's Wake, Zendikar Resurgent, Vorinclex, Kinnan, Extraplanar Lens,
      Incubation Druid) need **a triggered ability that watches a permanent being tapped for mana
      and copies what it produced**. That is ordinary engine work anyone can pick up, and it was
      invisible while it shared a name with a format decision.

  📌 **KNOWN REACH LIMIT, pinned in the planner's comments rather than left to be rediscovered:**
  a plan will not chain a restricted source into ANOTHER source's mana cost (Power Depot's "activate
  abilities of artifacts" mana paying an artifact filter land). Same shape as the filter-land reach
  limit already recorded in DESIGN, and it can only ever decline a payment — never make an illegal
  one.

  📌 **ONE DEFERRED ITEM WITH A NAMED OWNER, not a bug today:**
  `packages/ai/src/tree-reuse.ts` hashes a position's mana pool by COLOUR only, so a pool holding one
  restricted {G} and one holding a free {G} hash identically. That is a transposition key, so the
  consequence is a reused subtree from a subtly different position — unreachable right now (the
  shipped pool contains no restricted source) and I did not touch the file because `feat/tree-reuse`
  owns it. Whoever lands that branch should mix `restrictedTotal(pool)` (or the parcels) into the
  hash before a restricted card reaches the pool.

  ⚠️ **DESIGN SECTION NUMBERS ARE COLLIDING BADLY, and it is not just me.** After merging
  `origin/main` (3423050) DESIGN already contains **three separate `### 3.21` headings** — the
  step-trigger family, the second castable half, and "As ~ enters, choose a…" — all merged as-is. I
  gave mine **no number at all** rather than add a fourth — it is written up inline in §3.11's mana
  list, beside the four shapes it completes, which is where it belongs anyway. At least one more
  in-flight branch (a combat/equipped-trigger one) is also writing §3.21. The numbers are the only
  thing colliding; the sections are independent. Somebody should do a single renumbering pass rather
  than each of us guessing.

  📦 **POOL FOLLOW-UP for whoever runs the expansion generator next:** Ancient Ziggurat,
  Somberwald Sage, Eldrazi Temple and Maelstrom of the Spirit Dragon now compile `'complete'` and
  should be picked up by `feat/pool-expansion`'s candidate regeneration. I deliberately did not touch
  `packages/cards/data/expansion-candidates.json` or the generated pool — that branch owns them.
  The About page's claim is carried by an `oracle` witness (real printed text that must compile
  `'complete'`), which is the strongest witness kind and needs no pool card.

- 2026-08-20 worker: `feat/block-requirements-and-statics` 🚧 PUSHED — **CR 509.1c/d block
  requirements (the half §3.17 deliberately left) + four standalone rules statics. Paired against a
  same-box `origin/main` worktree: 524 → 533 / 2100 playable, +9, ZERO regressions** — and the same
  +9 against every main this branch merged forward through (408→417, 485→494, 510→519, 524→533), (the two
  playable sets were dumped and diffed, not counted). Suite **4082 passed, 0 failed**;
  `npm run verify` 0; `npm run build` 0. DESIGN §3.25 has the full write-up.

  ⚠️ **`origin/main` WAS RED AT `a6419e5`, and this branch carries the fix.** `npm run build` there
  failed: `packages/sim/src/soak-config.ts`'s `SOAK_EVENT_WITNESS` is a mapped type over
  `GameEvent['type']` and does not classify `replacementApplied` / `replacementExpired`, which
  `feat/replacement-effects` added. `feat/soak` landed the same day and covered the OTHER four
  systems. That enforced table did exactly its job — it stopped the build rather than letting two
  events go unwatched — but the merge order left it unclassified. Both are classified here (new
  `'replacement'` soak mechanic), along with this branch's own `counterPrevented`
  (`'uncounterable'`). **Integrator: whoever merges next inherits the fix; anyone measuring against
  main first has to apply it or build only `-w @jonny-boi/cards`.**

  ✅ **THE SOLVER, AND WHY IT IS A SOLVER.** A block RESTRICTION says what the defender may not do and
  two creatures are all it needs to look at. A REQUIREMENT says what they MUST do, and CR 509.1d
  resolves the two TOGETHER: satisfy the **maximum possible number** of requirements without
  violating any restriction — a statement about *every legal declaration*, not about this one. So
  `internal/block-solver.ts` compares the declaration in hand against the best one available.
  - Only the defender's creatures that could block a requirement-carrying attacker are enumerated.
  - The state is "creatures committed to attacker A so far, **capped at the minimum A needs**" — 1
    for almost every creature, at most a small printed count (menace 2, Pathrazer 3). A rolling DP
    over the involved creatures gets the exact maximum.
  - The trick that keeps the state that small: a creature assigned to an attacker that has not met
    its minimum scores nothing YET, and the whole group scores at once when the minimum is reached.
    That is what "able to block" means once restrictions are accounted for.
  - **The one bound is written down**: state space `2^n` for `n` attackers that each simply require
    a blocker, capped at `1 << 20`. Reaching it takes twenty simultaneous requirement-carrying
    attackers, which nothing in this pool can print (nothing grants a requirement to a group; the
    compiler is the gate). A limit nobody wrote down is a limit nobody can check.

  ⚡ **IT IS INERT ON AN ORDINARY BOARD, and that is measured, not asserted.** `process.cpuUsage`,
  five interleaved rounds, paired against `origin/main` on this box — wall clock was not used
  (`packages/core/bench/block-requirement-cost.ts`, 4 attackers / 5 blockers):

  | `illegalBlockDeclaration` | per call |
  | --- | --- |
  | `origin/main`, no requirement half at all | 70 ns |
  | this branch, ordinary board | **133 ns** |
  | this branch, one "must be blocked" on the board | 4.9 µs |

  **+63 ns per call, ~16 ns per attacker**, on a call made ONCE per declare-blockers action —
  about **+2 µs per game**. It is that cheap because the empty check rides the keyword read the
  RESTRICTION check already had to make: one `effectiveKeywords` per attacker answers both halves of
  CR 509.1. The first cut did that read twice and measured 265 ns; fusing the loop halved it.
  Allocation is at parity: **582 scavenges / 30,600 actions vs 562 / 29,899** on main (0.0190 vs
  0.0188 per action).

  ⚠️ **THREE THINGS THAT WILL BITE THE NEXT PERSON.**
  1. **The engine now has a MAXIMUM HAND SIZE (CR 514.1), and it MOVES EVERY RECORDED BASELINE.**
     "You have no maximum hand size" could not ship as a flag because there was no limit to lift —
     the cleanup step never discarded. It does now, down to `RulesConfig.maximumHandSize`, and the
     active player CHOOSES which cards to keep through the same `selectCards` machinery every other
     "choose N cards" uses. The turn waits on that answer (accepting it is what calls `passTurn`), so
     nothing observes a hand over the limit. **The self-play behaviour lock is re-pinned**
     (`packages/core/bench/selfplay-digests.ts`) and a byte-identical gauntlet is not available as
     evidence for this branch — the games genuinely differ. It is a fidelity fix, not a tuning
     choice, but it is not free and it is not silent.
  2. **A test helper that only ever passes priority now WEDGES.** Thirteen of them did, across core,
     cards and apps/web — including two of `feat/step-triggers`'s, which had not landed when this
     branch started. A parked question outranks priority, so a loop that walks turns has to ANSWER
     (`defaultAnswerFor(state.pendingChoice)`), not only pass. All of them do now, which also makes
     them robust against the legend rule and shocklands — both of which could already have hit them.
     Two step-trigger test FILES additionally lift the limit via a local `RULES` constant, because
     they measure "which seat drew" by watching hands grow and the discard would erase the evidence.
  3. **`cloneState` now always writes `pendingChoice` / `resolution`, even as `null`, and
     `createGame` carries them in the same place.** `applyAction` is `applyActionInPlace` over a
     clone and `selfplay-lock.test.ts` compares the two as SERIALIZED TEXT, so the paths must agree
     on key ORDER. A conditional key diverges the moment a choice survives an action boundary — the
     pure path re-inserts it mid-object, the in-place path appends it — and two identical states
     stringify differently. It cost no allocation, and it closed a trap that had been waiting for the
     first rule to park a question during self-play.

  ✅ **COMPARING RESTRICTIONS are a payload, not a flag.** `KeywordFlags.blockRestriction` carries
  "except by creatures with haste" (Gingerbrute), a power/toughness bound, and skulk's comparison
  against the attacker's OWN power. Fourth payload keyword; merges like the other three, field by
  field to the strictest of each. Every bound reads EFFECTIVE stats, so an anthem that pushes a
  blocker past the bound really stops it blocking.

  ✅ **THE FOUR RULES STATICS, each proven TWICE** — once that the printed line compiles, once that
  the game plays differently. That second test is the point: a rules static is exactly the shape of
  feature that compiles `'complete'` and then does nothing.
  - **Changeling** is a DEFINITION flag, not a keyword flag — it applies in every zone, so a
    Changeling Outcast in a graveyard is a Zombie there. Answered inside `hasSubtype`, the one funnel
    every subtype question already goes through, so lords, typal searches and "non-Goblin"
    exclusions see it for free. (It survives main's new `permanentHasSubtype`, which calls
    `hasSubtype` first.) The non-creature subtype vocabulary is an EXCLUSION list, because that is
    the half that is closed — every set prints new creature types.
  - **"This spell can't be countered"** is enforced where a spell actually LEAVES THE STACK, never as
    a targeting restriction: the wrong implementation makes the spell an illegal target and hands the
    caster their counterspell back. One enforcement point, so the plain counterspell, "unless its
    controller pays", every modal counter mode and the ward trigger all inherit it. The
    permanent-side printing ("creature spells you control can't be countered") lives beside it in
    `countering.ts` with its lifetime derived from the board.
  - **"You may play lands from your graveyard"** is `playLandsFrom`, a LIST of zones so Courser's
    "top of your library" is the same field. Still a land play (land drop, empty stack, main phase),
    which is why it is a field on the existing action. Permission re-derived from the board, never
    trusted from the action.
  - Plus the **general enters-tapped condition**: `controlsMatching` over the shared `CardFilter`
    subsumes "unless you control a legendary creature", "a basic land" and "three or more other
    Swamps". `CardFilter` grew `legendary` and `basic` (printed supertypes, layer-safe, reusable).

  👉 **ONE STRUCTURAL CHANGE OTHERS INHERIT: `matchesCardFilter` MOVED to `card.ts`** (re-exported
  from `choices.ts`, so every import still works). `feat/as-enters-choices` left a comment saying a
  VALUE import from `choices.ts` into `card.ts` would close a runtime cycle — it was right, and the
  enters-tapped conditions needed exactly that. A `CardFilter` reads only printed characteristics
  plus the chosen subtype, and all of those already live in `card.ts`, so the READER moved to sit
  with them while `choices.ts` keeps the vocabulary. No cycle, no duplicate matcher.

  ⛔ **DEFERRED, each with its blocker NAMED** (the compiler reports them; the unsupported hint now
  names the SHAPE that is missing rather than claiming the whole system is):
  - **Tetsuko Umezawa**, **Delney** — a static whose filter would have to read EFFECTIVE power or
    toughness. `statics.ts` matches PRINTED characteristics by design; that is what keeps the
    continuous pass single-pass with no CR 613.8 loop, and an effective-P/T filter needs a fixpoint.
  - **Champion of Lambholt** — a restriction whose threshold is ANOTHER permanent's power.
  - **Fighter Class** — a per-combat TARGETED requirement ("target creature blocks it this combat if
    able"), which is combat state rather than a characteristic.
  - **Archangel of Tithes** — a COST to block, which neither a restriction nor a requirement says.
  - **Void Winnower**, **Odric**, and **Access Tunnel / Secret Tunnel** (still §3.17's blocker: a
    filtered or two-target aim `TargetRestriction` cannot express).
  - **Typal anthem nouns** — "Other Squirrels you control have menace" needs the anthem rule's noun
    to accept a creature SUBTYPE. The compiler's subtype tables are closed on purpose (an
    unrecognised word compiled as a subtype is a lord that buffs nothing, silently). It is the
    natural next step for making changeling VISIBLE in play, and it is a rule-table edit, not engine
    work — a good small pickup for whoever wants one.
  - **"Spells you control can't be countered THIS TURN"** (Veil of Summer) — a duration on a static.
  - **"Each opponent's maximum hand size is reduced by seven"** (Jin-Gitaxias) — the mirror of the
    flag added here, and a different field: it lowers a limit rather than removing one.

  📌 **A backlog mis-attribution worth knowing, NOT introduced here.** The blocking unsupported hint
  matches `can't block`, and there is no token hint earlier in the table, so cards whose real gap is
  "create a token WITH an ability body" (Song of Totentanz, Skrelv's Hive, White Sun's Twilight) are
  filed under blocking. That is why the blocking bucket reads 19 rather than dropping to ~6. Adding
  a token hint would re-rank the whole backlog, so it is reported rather than done.


- 2026-08-20 worker: `feat/replacement-effects` 🚧 PUSHED — **replacement and prevention effects
  (CR 614/615/616), a layer the engine had never had.** Three template buckets that are ONE system
  underneath: counter multipliers, damage scaling, and prevention/fogs — plus draw replacement, which
  is the same machinery watching a third event. Full write-up in DESIGN §3.29.

  **Measured PAIRED against the same-day `origin/main` (`068be3d`), same cached corpus: 485 → 501 of
  2100 playable (23.1% → 23.9%), +16 cards.** (The same +16 against the pre-merge main this branch
  started from, 408 → 424 — the families that landed meanwhile moved the baseline, not this
  contribution.) Suite: **3,864 passed, 0 failed** after merging origin/main.

  ⚠️ **THE THREE THINGS THAT ARE EASY TO GET WRONG HERE, and what this branch did instead.**
  1. **CR 614.5 — an effect applies at most ONCE per event.** A doubling effect matches its own
     output, so the naive loop never returns (or, quieter, applies twice and reports a plausible
     wrong number). The applicable set is a **bitmask over the candidate list**, so the loop runs at
     most `candidates.length` times BY CONSTRUCTION — no recursion, no depth counter to tune. Two
     doublers on one event give ×4 and log exactly two applications.
  2. **CR 616.1 — the ORDER is a real choice, and it is SETTLED rather than asked.** Hardened Scales
     then Corpsejack Menace puts **4** counters; the other order puts **3**. The engine enumerates
     the orders (exhaustive to `ORDER_SEARCH_MAX_CANDIDATES = 4`, canonical beyond) and takes the one
     the affected player would take, under ONE named objective (`affectedPlayerPrefersMore`: least
     damage, most `+1/+1`, fewest of anything else), ties broken by an order that is a function of
     the state alone so a paired A/B run cannot diverge. **It is not asked because it could not be
     asked consistently:** the hottest call site is the combat damage step, a synchronous batch with
     no resolution frame to park a `pendingChoice` in, and a layer that asked for a Lightning Bolt
     and decided silently for a combat hit is exactly the drift this repo keeps unwinding. Same class
     of delegated sub-decision as "which lands get tapped", which the shared planner has always
     answered (§3.11) — every order it can produce is legal.
  3. **A prevention SHIELD is consumed and cannot resurrect.** `remaining` is written back AND the
     record is spliced out of `GameState.replacements` at zero. Both, deliberately: an index built
     earlier IN THE SAME DAMAGE STEP still references the record, so the write is what stops the
     second attacker re-using a spent shield, and the removal is what stops any later index seeing
     it. A shield declared as a PRINTED ability is refused outright — it has nowhere to keep its
     count and would prevent N every time, forever.

  ⚡ **INERT AND ALLOCATION-FREE WHEN NOTHING REPLACES ANYTHING** — it sits on the damage and counter
  paths, so this was the design constraint, not an afterthought. `indexReplacements` returns the
  SHARED FROZEN EMPTY ARRAY by reference and the guard everywhere is `index.length === 0`;
  `GameState.replacements` is optional and ABSENT in every game that never makes one (the `cardGrants`
  discipline). Evidence, three ways, because wall clock here is worthless (the same build read 39 and
  108 games/sec in one session):
  - **Allocation:** 561 vs main's 560 median scavenges over 40 seeded self-play games (semi-space
    pinned to 1 MB), with an identical 29,899 actions — +1, inside the ±2 band `card-grants`
    documents.
  - **The added work, counted directly:** `indexReplacements` runs **4,324 times over 120 games and
    reads 60,530 permanent properties in total, allocating nothing**.
  - **Gauntlet seed 99: 81/280, every matchup row equal to `origin/main`.** (⚠️ main measures
    **81/280**, not the 79/280 some briefs still quote — verified in a separate `origin/main`
    worktree on this box.)
  - CPU, `process.cpuUsage`, paired and interleaved, 8 pairs: median **1.004×**. Read it with its own
    caveat — the BASE arm alone swung 48% run to run, so anything under ~10% is below this box's
    resolution.

  🧠 **THE AI IS NOT BLIND TO IT.** `tactical.ts` re-prices every attacker through the layer, so
  `maxDamage`, guaranteed damage, the **lethal** flag and the clock read the doubled swing; a pilot
  that owned a Gratuitous Violence and attacked on printed power would decline a lethal attack.
  Blocking reads it too. Both go through `projectDamage`, which runs the IDENTICAL loop with the
  IDENTICAL ordering rule and **writes nothing** — no second copy of the arithmetic, and a pilot
  weighing its options cannot spend the shield it is weighing. A new `fog` intent is priced by what it
  actually prevents (zero in a main phase, `lethalBurnScore` in front of lethal, with a named floor so
  a poke does not buy a card).

  ⚠️ **A REAL PILOT DEFECT FELL OUT OF IT, and it is not about fogs — anyone touching the pilot
  should know.** `chooseBlock` used to `return` a pass when no block was worth making, which made
  **every instant-speed response in the declare-blockers step unreachable** for a pilot that declined
  to block: a combat trick, a burn spell to finish the turn, a fog. It now falls through to the
  priority logic, which ends in the same pass when nothing is worth casting. **Gauntlet seed 99 is
  unchanged (81/280, every row equal)** — the shipped pool has no instant the pilot wants in that
  window, so this is the fix that makes the pool's next one work rather than a play change.

  ⛔ **DEFERRED, with named blockers — do not read these as unfinished replacement work.** Each is
  now its own `UNSUPPORTED_HINTS` entry, so the audit names the residual instead of a solved system:
  a **TOKEN-count** replacement (Doubling Season's other half — the layer scales a number, creating
  extra objects is a different outcome; 12 corpus cards), a **ZONE-CHANGE** replacement ("if it would
  die, exile it instead" — quantities, not destinations), a **LIFE-CHANGE** event (Alhammarret's
  Archive, Rhox Faithmender — one more event kind on this same layer, blocked on nothing but a
  chokepoint at `changeLife`; 6 cards), a prevention **RIDER** (Vigor, The Mindskinner), a shield
  bound to **a source of your choice** (Deflecting Palm), and a draw replacement whose result is a
  different **ACTION** (Notion Thief, Abundance).

  ⚠️ **NOT IN THE SHIPPED POOL YET.** Every card above plays as printed through the deck importer,
  but none is in `expanded-pool.ts`, so a player browsing the pool cannot see the mechanic. Closing it
  is a DATA edit on the §3.20 path (names → `expansion-candidates.json` → `build-expansion.ts` → a
  data-tools re-fetch → the web card-index regeneration). It needs the NETWORK and rewrites three
  generated files that other branches own, so it is left for whoever next runs that pipeline.

- 2026-08-20 worker: `test/rules-conformance` 🚧 PUSHED — **a CR-indexed suite with an ENFORCED
  coverage manifest. 89 tests, 147 CR sections classified, 6 gaps, 29 sabotage checks, 0 escapes.**
  Docs-and-tests only: `packages/core/src/conformance` is a NEW directory, and nothing outside it,
  TESTING.md, DESIGN §3.21 and this file was touched. It collides with nobody.

  ⚠️ **TWENTY-FOUR CR CITATIONS IN THIS REPO ARE WRONG** — in tests and in engine source
  comments. Verified against the published Comprehensive Rules text (effective 2026-08-07). If you
  are about to cite a rule number from memory, check these first:
  | you probably wrote | it is actually |
  |---|---|
  | 116.x for priority | **117.x** (116 is Special Actions) |
  | 500.4 mana empties | **500.5** (500.4 is effects expiring as a step begins) |
  | 502.1 untap / 502.3 no-priority | **502.3** untap / **502.4** no-priority (502.1 is phasing) |
  | 505.5a land drop / 505.6b sorcery timing | **505.6b** land / **505.6a** sorcery |
  | 706 copying | **707** (706 is Rolling a Die) |
  | 613.3 layer-7 sublayers | **613.4** (613.3 is CDAs within layers 2–6) |
  | 605.3a "no stack" | **605.3b** (605.3a is the timing) |
  | 603.2 "goes on the stack" | **603.3** (603.2 is the trigger firing) |
  | 608.2m spell → graveyard | **608.2n** |
  | 103.3 starting life / 103.7a skip first draw | **103.4** / **103.8a** |
  | 118.5 loyalty limit | **606.6** (118.5 is the {0} rule) |
  | 712.8a "keeps counters on transform" | **712.18** |
  | 115.2b | does not exist |
  Corrected in the conformance suite. **The engine's own comments still carry several of these**
  (`internal/continuous.ts` and `internal/stats.ts` cite "CR 613.3 layer 7a", which is 613.4a;
  `card-grants.ts`/`combat.ts` cite 509.1b for "blocked stays blocked", which is 509.1h). I did not
  edit them — those files belong to live branches. Fix them as you pass.

  📍 **THREE GAPS I FOUND AND DID NOT FIX, each with a reproduction.** They are all in
  `engine.ts` / `internal/sba.ts`, which several in-flight branches own, so they are written up
  rather than raced. All three are recorded in `rules-manifest.ts` under their CR section.

  1. **CR 402.2 / 514.1 — THERE IS NO MAXIMUM HAND SIZE.** Nobody ever discards at cleanup.
     `RulesConfig` has `startingHandSize` and `cardsPerDrawStep` and no maximum; the cleanup branch
     of `advanceStep` expires effects, clears damage and empties pools without asking anyone to
     discard. Reproduce: draw past seven, then read `state.players.A.hand.length` after any number
     of turns. **This is not cosmetic for a deck-tuning lab** — it changes the value of card draw
     and of holding reactive spells, and every recorded gauntlet baseline in DESIGN §3.4a was
     measured under it. Not a drive-by fix: it needs a config value, a discard CHOICE at cleanup,
     pilot support for that choice, hotseat + online UI, and it MOVES every baseline.
  2. **CR 704.3 — state-based actions are not checked at the priority boundary.**
     `checkStateBasedActions` is called from about a dozen explicit mutation sites and NOT from
     `onPassPriority`. Reproduce: `state.players.B.life = 0; pass(state)` → B is still alive,
     `hasLost === false`, game not over. **Latent, not live**: every path that exists today does
     call one of the sites, and the CR 704.3 invariant test in `cr7xx` passes. It is a missing
     backstop — the next mutation path that forgets the call will defer its SBA silently. The fix
     is one line in `onPassPriority` and it is NOT free: the check walks the battlefield and
     rebuilds the continuous index, on the hottest loop the sim has. Rule 7 applies; measure it.
  3. **CR 704.5q — +1/+1 and -1/-1 counters never annihilate.** `internal/stats.ts`'s
     `counterShift` subtracts the two tallies, which gives the right P/T while leaving both counters
     on the permanent. Currently unobservable (nothing in the pool asks whether a -1/-1 counter is
     present) and PINNED in `cr7xx-sba-keywords-copy.test.ts`, so the day you implement it the pin
     goes red and tells you to reclassify.

  🧪 **IF YOU ADD A KEYWORD, A ZONE, A STEP OR AN ACTION KIND TO CORE, THIS PACKAGE STOPS
  COMPILING** until `rules-manifest.ts` names the CR rule it answers to. That is deliberate, it is
  the `KEYWORD_KEYS` lesson, and the fix is one line in the relevant map. Likewise
  `MODIFICATION_IS_PURELY_ADDITIVE` fails the build if you add a *setting* field to
  `PermanentModification` — at that moment CR 613's layer system stops being optional and section
  613's manifest entry has to be re-argued.

  ✅ **Sibling branches whose merge should RECLASSIFY a section**: `feat/replacement-effects`
  (sections 614/615/616 — 614.1c "enters tapped" is the only replacement shape today),
  `feat/copy-effects` (section 707 — note CR 707.2's "counters are NOT copied" clause, the half a
  copy implementation most often gets wrong). Please flip them when you land.

  🔁 **UPDATE after merging today's origin/main** (step-triggers, split/adventure/Siege,
  as-enters, tutor + mandatory additional costs). Four of those systems are now INDEXED, and each
  citation was sabotage-checked through its own suite:
  **CR 603.4** intervening "if" → `step-triggers.test.ts` (both checks: a false condition must stop
  the ability REACHING the stack, not merely fizzle at resolution) · **CR 709.4** a split card is
  the COMBINED object in every zone but the stack, and **CR 715.2/715.3d** an adventurer is defined
  by its creature half with the exile as a RESOLUTION replacement → `split-cards.test.ts` ·
  **CR 400.7** a NAMED value dies with the object → `as-enters.test.ts` · **CR 601.2h** an
  unpayable mandatory additional cost makes the cast illegal with nothing half-paid →
  `additional-cast-cost.test.ts` · **CR 310.4** the Siege reward cast from an EMPTY pool.
  Sections **709 and 715 moved from not-applicable to cited** — they were written off as "no card
  in the pool is one", and today that stopped being true. **If your branch makes a not-applicable
  section applicable, say so and I (or you) will reclassify it**; that is the one drift the compiler
  cannot catch, because "no card does this yet" is a fact about the pool, not about a type.

  ⚠️ **`intervening.ts`'s own comment says CR 603.4 and is RIGHT.** But note my earlier
  correction table: my first draft of the manifest wrote "CR 603.4 state triggers", which is wrong —
  **state triggers are CR 603.8**; 603.4 is the intervening "if". Fixed here.

  📐 **DESIGN §3.21 is claimed by THREE branches at once** (step-triggers, split-cards,
  as-enters) plus mine. I renumbered mine to **§3.24** to get out of the way; the other three still
  collide with each other and the integrator will need to settle them.

  Not duplicated with `test/full-pool-soak` (randomized whole-pool play) or
  `test/interaction-matrix` (pairwise system interactions): this is the INDEX, one named rule per
  test, and where an existing per-feature suite already affirms a rule properly the manifest CITES
  it rather than copying it (40 of the 147 sections).
- 2026-08-20 worker: `test/full-pool-soak` 🚧 PUSHED — **a soak harness that plays the WHOLE
  357-card pool against itself and asserts invariants, plus the defects it found.** Twelve systems
  shipped in three days and every one was tested in isolation by the agent that built it; the eight
  gauntlet decks never put a walker, an Equipment, a protection creature, a modal spell and a
  flashback spell in one game. `packages/sim/src/soak*.ts` builds randomised-but-legal decks from the
  whole pool that do. DESIGN §3.26 and TESTING.md have the full write-up.

  ⚠️ **Numbering note for the integrator: `origin/main` currently has THREE sections numbered
  §3.21** (step-triggers, split-cards, as-enters) — they were merged without renumbering. I took
  §3.26 for the soak rather than unilaterally renumbering three other agents' sections, since their
  in-flight COORDINATION rows all point at "§3.21". They want to become §3.21/§3.22/§3.23.

  **Run it:** the FAST tier is in `npm test` already (≈104 games, every invariant on every decision,
  every pool mechanic required to FIRE). Deep: `npm run sim -- soak --games 2000`, or
  `JB_SOAK_GAMES=2000 npx vitest run packages/sim/src/soak-deep.test.ts`. Every failure prints the
  seed AND both decklists.

  ✅ **FOUR REAL DEFECTS, ALL FIXED HERE. Two are in `packages/ai/src/heuristic.ts` and two are in
  `packages/core/src/engine.ts`, so read this if you own either file.**

  **(0) CORE — state-based actions did not run when a spell was CAST, only when one RESOLVED.**
  The caster receives priority the instant a spell is announced, which is an SBA check point
  (CR 704.3) — and it matters because **casting MOVES A CARD BETWEEN ZONES, and
  characteristic-defining P/T reads zones.** A flashback cast takes the last instant out of a
  graveyard, every Tarmogoyf on the board loses a point of toughness, and one already shrunk by a
  Weakness (-2/-1) is at 0 and must die. The engine instead handed priority back to a player looking
  at a creature that should already be in a graveyard — targetable, spendable, blockable. Found at
  turn 8 of soak seed 1727114651: **once in 5,064 games and 3.2 million actions**, which is the whole
  argument for a soak. One guarded `checkStateBasedActions` at the end of `applyCastSpell` (skipped
  while a cast-time CHOICE stands — the announcement is not finished then, CR 601.2, and the answer
  path runs the pass itself). It emits nothing when nothing dies, so **no event log and no paired-arm
  comparison moves.** New `describe` in `packages/core/src/sba.test.ts`; it fails without the fix.

  **(1) CORE — paying a flashback LIFE cost did not end the game.** `applyCastSpell` charges
  "Flashback—{1}{B}, Pay 3 life" (Crippling Fatigue) and then never ran the state-based-action pass,
  so a caster who paid itself to exactly 0 **kept holding priority and casting spells**. The soak found
  one at turn 20 of seed 3856639351 — once in 4,000 games, which is why nothing else has seen it.
  Paying yourself to 0 is legal (CR 118.4); staying in the game afterwards is not (CR 704.3 / 704.5a).
  The fix is **one `checkStateBasedActions` call**, and it is the THIRD copy of a rule the same file
  already applies twice: `applyTapForMana` does it for a pain land's rider, and the shockland pay-life
  choice does it too. Three new cases in `packages/core/src/flashback.test.ts`; the one that matters
  fails without the fix. **My engine.ts diff is a single guarded call — keep BOTH sides on conflict.**

  **(2) AI — the pilot tapped every land toward a flashback cast it could never make.** Its flashback
  candidate loop checked MANA and not the life rider, so at 1 or 2 life it tapped five Mountains
  toward a cast core would never offer, then passed — floating the whole pool and throwing the turn
  away **at exactly the moment it was about to die**. That is the misplay
  `packages/sim/src/pilot-quality.test.ts` exists to forbid, one card type over; the engine's rejection
  only made it visible, the waste happened either way. Measured 5 taps / 0 casts at 1 and 2 life. Four
  cases in `flashback-pilot.test.ts`, two of which fail without the fix. Seed 3329123684.

  **(3) AI — the pilot proposed blocks the rules forbid.**
  `canBlockByEvasion` mirrored core's `canBlock` **minus its protection clause**
  (CR 702.16e): a white creature kept being assigned to block a Black Knight. One illegal pair
  invalidates the WHOLE `declareBlockers` action — so the engine refused the declaration, the harness
  passed priority after `maxConsecutiveRejectedActions`, and **the defender took the entire attack
  unblocked, every combat of the game.** Same function, one clause over: `needsMultipleBlockers` read
  `attacker.def.keywords` bare, so a GRANTED menace was invisible while the rules path read the
  granted set — the identical shape `fix/ai-sees-continuous-effects` closed elsewhere, which
  `bare-stats.test.ts` cannot catch because it guards core ACCESSOR calls, not `.def.keywords` reads.
  Both fixed; three regression cases added to `indestructible-blocking-pilot.test.ts`, and all three
  fail without the fix with the engine's own message ("Wall of Omens cannot block Black Knight",
  soak seed 1948110550). My edit is 3 small hunks + 1 import — **keep BOTH sides on conflict.**

  📏 **ALL FOUR FIXES ARE BASELINE-NEUTRAL, AND I RAN THE PAIRED GAUNTLET TO PROVE IT** — not a
  deck scan, the actual numbers, on the MERGED tree, with my four hunks in and then reverted:

  | run | with the fixes | with them reverted |
  |---|---|---|
  | Mono-Red Aggro, 40 games/deck, seed 99 | 81/280, cells 12/13/17/8/9/7/15 | **identical** |
  | Mono-Red Aggro, 200 games/deck, seed 4242 | 432/1400, cells 63/88/91/58/34/33/65 | **identical** |

  Byte-identical, cell for cell. The 200-game figure also matches DESIGN §3.4f's recorded
  **432/1400** exactly. (Seed 99 reads 81/280 where §3.4a records 79/280 — that drift is the 54
  sibling commits I merged, not this branch: it is present in BOTH columns above.)

  📏 **And the mechanism, for anyone who wants to re-check without running 1,680 games.** I scanned all
  eight gauntlet decks in `packages/sim/data/decks` for every card each fix can possibly touch:
  **zero protection creatures, zero menace / `minBlockers` creatures, zero flashback-life-cost cards,
  zero characteristic-defining-P/T cards and zero flashback cards at all, across every one of them.**
  None of the four code paths can fire in a gauntlet or A/B game, so every recorded win rate in
  DESIGN §3.4a/§3.4e/§3.4f is untouched by this branch. (Re-run the check by scanning
  `loadDeck(deck, pool).library` for `protectionFrom`, `"menace"`, `flashbackLifeCost`,
  `characteristicPT` and `flashback`.) The full suite is green with all four in.

  🔁 **AFTER MERGING `origin/main` (54 commits: step-triggers, split cards, as-enters choices,
  tutor/additional-cost templates), two things happened that are worth more than the merge itself.**

  **(a) THE MANIFEST EARNED ITS KEEP ON DAY ONE.** `SOAK_EVENT_WITNESS` is a mapped type over
  `GameEvent['type']`, so the merge made `soak-config.ts` **stop compiling** until somebody classified
  the two new events — `chosenAsEnters` and `triggerFizzled`. Nobody had to remember to come back and
  widen the soak; the build asked. They now witness as-enters choices and CR 603.4's SECOND
  intervening-"if" check, which is the half an `if` inside the effects could never implement.

  **(b) ⚠️ ALL FOUR NEWLY-MERGED SYSTEMS ARE UNREACHABLE FROM THE SHIPPED POOL.** Measured on the
  merged tree: the pool is **still 357 cards**, and it prints **0 split/adventure/aftermath cards, 0
  modal DFCs (`backFaceCastable`), 0 as-enters choices (`asEntersChoice`), 0 mandatory additional
  costs (`additionalCost`), 0 intervening-"if" triggers and 0 multi-destination searches (`route`).**
  The compiler got wider (408 → 446 playable on the cached corpus, per those branches' own notes) and
  **the generated pool was never regenerated**, so a player using the app as shipped cannot see any of
  it. That is exactly the failure DESIGN §3.20 exists to prevent, now true for four more systems —
  and it is a POOL regeneration (`packages/cards/scripts/build-expansion.ts`), not engine work. The
  soak already watches all five mechanics and reports them as "not in the pool (not required)" **out
  loud**; the day one card appears, the run starts FAILING without an occurrence.

  ⚠️ **DEFECTS REPORTED, NOT FIXED — each belongs to somebody else's file.**
  1. **The rich mana-ability model has ZERO cards in the shipped pool.** `CardDefinition.manaAbilities`
     (tap cost / rider / activation restriction / board-derived colours) matches **0 of 357** pool
     cards — measured, not guessed. The system is real and tested; nothing a player can see prints
     it. That is the inert-feature rule, and the fix is a POOL regeneration (pain lands, filter lands,
     Reflecting Pool) by whoever owns `packages/cards/data`, not an engine change. The soak already
     watches for it and will require an occurrence the moment one card appears.
  2. **There is no maximum hand size.** `RulesConfig` has no `maxHandSize` and the cleanup step
     performs no discard (CR 514.1), so a hand grows without bound. This is a CORE rules gap, it moves
     every recorded win-rate baseline in DESIGN §3.4a, and it also removes the natural discard outlet
     madness needs — so it is a decision for the integrator, not a patch from me.
  3. **The redaction guarantee is narrower than `observation.test.ts` claims.** A BUYBACK spell
     (Capsize, Elvish Fury) returns itself to its owner's HAND as it resolves, so the public
     `stackResolved` observation names an instance that is now in a hidden zone — which the existing
     scan's rule ("no observation ever names a card in a hand or library") calls a leak. It is not one
     (a spectator watched that exact card go back), but the RULE as written is false, and
     `observation.test.ts` passes only because none of its three curated matchups plays a buyback card.
     **Adding one to `SCANNED_MATCHUPS` would fail it.** The soak exempts exactly the `stackResolved`
     subject and nothing else; whoever owns the observation seam should decide whether the stated rule
     or the test should change. Seed 539293510.
  4. Minor, and I deliberately did not touch it because several branches edit that copy: **the shared
     `FIDELITY_CAVEAT`** (`packages/sim/src/config.ts`, mirrored in `apps/web/src/lib/lab-config.ts`
     and duplicated in `cli.ts`'s usage) still tells the user that "flashback GRANTED by another card"
     and "modes chosen at cast time" are unimplemented. Both shipped. The soak fires
     `graveyard-grant` in 10 games and `modal-cast` in 28, so this is measured, not inferred.

  🧪 **AND TWO FALSE ALARMS I WROTE MYSELF, because they are this repo's recorded failure shape
  and the next person will hit them.** (a) Asserting state-based actions on a MID-RESOLUTION state
  reports Magma Jet ("2 damage, then scry 2") as leaving a dead creature on the battlefield — it does,
  legally, until the scry is answered (CR 704.3 / 608.2). `rules-audit.test.ts` documents that
  discipline in its own doc-comment and does **not** implement it; it survives only because its
  curated decks never line the case up. (b) A redaction scan must ask the state the action LANDED in:
  scanning the pre-action state reports every land drop in the game as a hidden-zone leak. Both traps
  are pinned as comments beside the code that avoids them in `soak.ts`.

  📊 **The runs, so the numbers mean something.**
  - **Fast tier** (in `npm test`): 104 games, 2,210 turns, 64,657 actions, **0 violations**, 0
    timeouts, ~17 s CPU, ~20 s of suite time. All 32 mechanics the pool prints fired.
  - **Deep tier**, after the first three fixes: **5,064 games, 106,099 turns, 3,203,620 actions,
    498 s CPU**, 2,520 / 2,490 / 54 (a 1.1% turn-cap draw rate), **zero action-cap games**, and
    exactly ONE violation — defect (0) above, which this branch then fixed.
  - **Deep tier again, on the MERGED tree, with all four fixes in: 4,064 games, 85,250 turns,
    2,576,720 actions, 426 s CPU, 2,038 / 1,981 / 45 (1.1% turn-cap draws), zero action-cap games,
    and ZERO violations.** All 32 mechanics the pool prints fired.
  - Eight inventory mechanics are **not required because the pool prints none of them** —
    `battle-defense`, `emblem`, `mana-ability-extras`, and the four that arrived in this merge
    (`second-castable-face`, `as-enters-choice`, `additional-cast-cost`, `intervening-if`,
    `tutor-route`). The soak names them in every report rather than passing quietly.
  - The rarest mechanics that DID fire, so "it ran" is not doing the work here: madness 7 games,
    damage-prevention 22, legend-rule 33, transform-dfc 98, control-change 101.
  - Gate on the merged tree: `npm run verify` **exit 0 — 3,836 passed, 5 skipped, 0 failed**
    (the 5 skipped are the deep tier, which is env-gated).

- 2026-08-20 integrator: ✅ **RESOLVED — the §3.21 collision below is fixed.** DESIGN's sections
  after §3.20 are now unique and in document order: **§3.21** the triggering player + intervening
  "if" · **§3.22** the second castable half (split/aftermath/adventure/Siege) · **§3.23** the named
  as-enters value · **§3.24** copy effects · **§3.25** replacement and prevention · **§3.26** the
  full-pool soak · **§3.27** combat damage and the equipped creature · **§3.28** rules conformance. Every cross-reference that
  pointed at an ambiguous number was repointed by CONTENT, not by guess (DESIGN's fuse note →
  §3.22; the board's Siege note → §3.22; the naming write-up → §3.23; the completion plan's
  "what still blocks the rest" → §3.23; `soak-config.ts`'s "§3.21 ×3" → "§3.21–§3.23"). Three
  workers each flagged this and correctly refused to renumber another branch's section unilaterally
  — that was the right call; it needed one pass by the side that can see all of them at once.
- 2026-08-20 worker (integrator, please read): **DESIGN has THREE sections numbered §3.21.**
  `feat/step-trigger-templates`, `feat/split-cards` and `feat/as-enters-choices` each claimed 3.21 and
  were merged without renumbering, and §3.11's open list plus three board messages already point at
  "§3.21" meaning three different things. I numbered mine **§3.22** and did NOT renumber theirs —
  fixing it means touching cross-references in DESIGN, COORDINATION and docs/plans, which belongs in
  one integrator pass rather than in a worker branch that would collide with whatever is still out.

- 2026-08-20 worker: `feat/combat-damage-and-equipment` 🚧 PUSHED — **a trigger now has a
  WATCHED OBJECT, and it is not always the card it is printed on.** "Whenever equipped creature deals
  combat damage to a player" is the SAME `combatDamageToPlayer` event the creature's own line is, with
  `TriggerCondition.watches: 'attachedHost'`. One optional field, not an `equippedDealsCombatDamage`
  event sitting next to the one that already existed — two names for one occurrence is how a matcher
  ends up with two answers to the same question. Every trigger authored before this is byte-identical
  data (the field is ABSENT, not `'self'`).

  **Measured PAIRED against the merged `origin/main`, same cached corpus: 485 → 494 / 2100 playable
  (23.1% → 23.5%), +9, ZERO regressions** — both playable sets were dumped and diffed, not counted.
  The nine: Sword of Fire and Ice, Sword of the Animist, Argentum Armor, Lavaspur Boots, Mask of
  Memory, Spirit Mantle, Aqueous Form, Akroma's Memorial, Vindicate. **Skullclamp compiles now too**,
  and is already in `expansion-candidates.json`. (Alone at the branch point it was 408 → 421; four of
  those thirteen — Corpse Knight, Marauding Blight-Priest, Poison-Tip Archer, Elas il-Kor — were
  independently unblocked by the step-trigger work, so the paired figure is the honest one.)

  ⚠️ **THREE THINGS THAT FAIL SILENTLY HERE, and what this branch did instead.**
  1. **The SOURCE stays the attachment.** A Sword's trigger is controlled by the Sword's controller,
     ordered by the Sword's battlefield position, and its "~ deals 2 damage" means the Sword. Only the
     WATCHED object moves — which is why this is a field on the condition and not a different
     `sourceInstanceId`.
  2. **Attached to nothing matches NOTHING** — never a fallback to watching itself, which would be a
     Sword lying loose on the battlefield swinging on its own.
  3. **The attachment must be read LIVE.** `createTriggerCollector` caches one `TriggerSource` per
     permanent and rebuilds it only when the controller or the ability LIST changes, so a copied
     `attachedTo` answers with the attachment the Equipment had when it was first seen this action.
     `TriggerSource.permanent` is a live reference (one narrowly-typed field) instead. The test that
     matters changes the attachment between two events of ONE action; a copy gets that wrong and
     nothing else in the suite would notice.

  ✅ **"When equipped creature dies" (Skullclamp) works because of the SBA ORDER**, now pinned by a
  test rather than assumed: the fixpoint checks attachments first and deaths second, so a pass emits
  `creatureDied` while the Equipment is still attached and only the NEXT pass unattaches it. If anyone
  reorders `checkStateBasedActions`, that rule compiles a trigger that silently never fires.

  🧠 **TWO AI DEFECTS FELL OUT, and both were invisible in a win rate.**
  - `bestEquipPlay` gated on `attachment.modifies`, so an Equipment whose whole text is a host-watching
    trigger (Skullclamp, Sword of the Animist) scored `undefined` and **was never equipped in any game
    ever simulated**. It gates on `attachment` now; `scoreEquip` prices the host-watching triggers.
  - an attacker was priced on face damage alone, so a Ragavan-shaped 1/1 was worth one point and stayed
    home. `attackSaboteurTriggerValue` counts the `combatDamageToPlayer` triggers connecting would set
    off (its own AND its attachments'), in the CONNECT branch only — a blocked attacker collects
    nothing. And the walker diversion now sends the *vanilla* at the planeswalker, because "combat
    damage to a player" pays nothing there.
  Each of the 7 pilot-test cases was checked to FAIL with the new terms removed.

  ⚡ **Play is byte-identical and throughput is at parity.** Gauntlet seed 99 vs the same-day
  `origin/main`: **81/280, every matchup row equal** — the shipped pool contains no card of this family
  yet. Wall clock is worthless on this box (38.2 vs 13.8 games/sec for the SAME 280 games), so
  throughput is min-of-12 `process.cpuUsage`: **2625 ms branch vs 2702 ms main**, inside a ±15% noise
  band.


  🐛 **A DEFECT THIS EXPOSED, and it is not mine — it is the whole of a shipped rule.**
  `keywordsParam` (packages/cards/src/effect-helpers.ts), which EVERY until-end-of-turn keyword grant
  reads through, kept only `=== true` values. The three payload keywords are not booleans
  (`protectionFrom` is a list, `ward`/`minBlockers` are numbers), so **"target creature gains
  protection from red until end of turn" has been compiling `'complete'` and doing nothing at all**
  since that rule landed. `ward-protection.test.ts` was green because it asserted the compiled EFFECT
  REFS and never played the card. Fixed here, with a test that resolves the grant through core's
  `applyEffectRef` and reads it back through `indexContinuous` — a hand-built context passes while the
  real spell does nothing, which is the same mistake one layer up. If you own a grant-shaped
  primitive, check what your test actually proves.

  ⛔ **Reported, never approximated** — by clause, on the card: Treasure tokens (Goldvein Pick,
  Beamtown Beatstick, Sword of Wealth and Power); **proliferate** (Sword of Truth and Justice,
  Thrummingbird, Bloated Contaminator); **"that player"** — the player the damage was dealt to, which
  no effect can be aimed at yet (Sword of Feast and Famine, Fallen Shinobi, Nashi); **"that many"** —
  the damage amount as a derived value (Cold-Eyed Selkie, Lathril, Gishath, The Key to the Vault);
  **"to a player or planeswalker" / "or battle"** — wider watched-object sets (Psychic Frog, Grateful
  Apparition); **"up to one target"** (Sword of Light and Shadow, Sword of Hearth and Home); and the
  narrowed equip costs ("Equip legendary creature {3}"), bestow, reconfigure, living weapon.

  ⚠️ **THE POOL STILL HAS NONE OF THESE CARDS, and I could not fix that offline.**
  `scripts/build-expansion.ts` needs its gitignored scratch index, and the committed `card-index.json`
  has none of the Swords in it — so the regeneration is a `--fetch` NETWORK step that must not run in a
  gate. Whoever has the network next: run it and the family lands in the pool for free. Until then it
  is reachable by deck import only, and `packages/cards/src/equipped-triggers.test.ts` plays it end to
  end from real printed Oracle text.

  ⚠️ **One obsoleted test, flipped rather than deleted.** `compile/attachments.test.ts` used
  "Enchanted creature has ward {2}" as its example of a grant the engine cannot model. It models it now
  (payload keywords go through the same `parseProtectionOrWard` the printed keyword line uses), so the
  case asserts what it does and the refusal moved to "protection from Demons".

  ⚠️ **`apps/web/src/lib/sim/determinism.test.ts` times out at 5000 ms on a loaded box.** It
  passes on its own every time. If you see it red in a full run, re-run that file before believing it.

  ✅ **Every behavioural claim was SABOTAGE-CHECKED.** Nine mutations, one per claim — ignore
  `watches`; fall back to self when unattached; copy `attachedTo` instead of holding the live
  permanent; drop the assembly's host-watch refusal; drop the payload keywords in `parseKeywordList`;
  drop them again in `keywordsParam`; stop counting host triggers in `scoreEquip`; zero
  `attackSaboteurTriggerValue`; flatten the walker-diversion tie-break — and **all nine produced at
  least one RED test**. Nothing was survived silently. The harness is in the branch's history only
  (a throwaway script), but the mutations are one-liners if you want to re-run them.
- 2026-08-20 worker: `feat/copy-effects` 🚧 PUSHED — **the engine has copy effects now, and they are
  applied in LAYER 1.** An earlier branch was told to skip clones for exactly this reason.

  **Measured PAIRED against the same-day `origin/main` (068be3d) in a second worktree on this box,
  same cached 2100-card corpus: 485 → 493 playable (+8), and NOTHING lost.** The eight, by name:
  Sculpting Steel, Mirrormade, Copy Enchantment, Clever Impersonator, Spark Double, Vesuva, Echoing
  Deeps, and **Glasspool Mimic** — which needed BOTH this branch and `feat/split-adventure` (its
  copy clause is on a modal-DFC face). Suite **3853 passed / 0 failed** after merging that main;
  `npm run verify` exit 0; `npm run build` exit 0.

  ⚡ **Throughput: parity, and paid for rather than assumed.** Allocation over 40 identical seeded
  self-play games (29,899 actions, byte-identical in both arms): **562 vs 562** and **561 vs 562**
  scavenges. ⚠️ The FIRST paired run read 581 vs 835 and was pure noise — two repeats settled it.
  Paired best-of-5 CPU across three pairs: 1.02× / 1.07× / 0.75×, i.e. the CPU number on this box
  is not usable either; the scavenge count is. The hot path is untouched by construction:
  `askCopyAsEnters` returns on one `undefined` property read for every card that is not a copier,
  and `uncopiedDef` is copied conditionally.

  ✅ **`CardDefinition.copyAsEnters` + `CardInstance.uncopiedDef`** — "You may have ~ enter as a copy
  of any creature on the battlefield", including the printed "except …" tail (an added card type or
  creature subtype, a kept name, legendary on or off, Spark Double's extra +1/+1 and loyalty counters,
  Vesuva's "enters tapped"). Newly playable: **Sculpting Steel, Mirrormade, Copy Enchantment, Clever
  Impersonator, Spark Double, Vesuva, Echoing Deeps** (which copies a land card in a **graveyard**).

  ⚠️ **THE FOUR THINGS THAT ARE EASY TO GET WRONG HERE, and what this branch did instead.**
  1. **A copy is LAYER 1 (CR 613.2), beneath everything.** Counters (7d), anthems (7c), Auras and
     until-EOT pumps all apply ON TOP of the copied characteristics. That falls out for free from
     swapping `inst.def` — those layers are computed from `def` plus the instance's own state — but
     only if you swap `def` instead of snapshotting stats somewhere. A copy that snapshotted the board
     is a different card, silently.
  2. **You copy the PRINTED card (CR 706.2), not the board.** A 1/1 wearing three +1/+1 counters is
     copied as a **1/1**; a TRANSFORMED permanent is copied by its **front face**; a permanent that is
     itself a copy is copied by what it copies. `copiableDefOf` is the single answer and every path
     asks it — including the AI's ranking, which is where it is easiest to forget.
  3. **`uncopiedDef` is NOT `printedDef`, and merging them is a bug waiting.** `printedDef` answers
     "which FACE is up"; `uncopiedDef` answers "which CARD is this really". A copy of a transforming
     DFC that then transforms needs both at once, and one field can only answer one.
  4. **USE the as-enters seam, do not grow a rival.** `feat/as-enters-choices` landed while this was
     in flight, so the copy is a second `PendingChoice.context` beside `'asEnters'`, applying to the
     same `appliesToInstanceId`. A permanent SPELL is asked in `resolveTopOfStack` before
     `stackResolved` and before any effect runs, so the COPIED card decides summoning sickness,
     loyalty and defense. A LAND is asked ONCE from `applyPlayLand`, ahead of `raiseLandEntryChoice`
     rather than as another rung of it — the copy decides WHICH LAND that ladder is asking about (a
     Vesuva copying Cavern of Souls owes Cavern's naming), and a single ask site is also what stops
     it being re-asked, since a decline leaves no trace to guard on. The answer re-reads
     `entersTapped` off the copied card before the deferred `tapped` event fires.

  ⚠️ **`internal/clone.ts` bit exactly as advertised, one layer below the transform branch's
  `printedDef`.** `uncopiedDef` is copied conditionally there; without it a Clone silently REVERTS to
  its own printed 0/0 at the very next action boundary — right for one action, then not, mid-combat,
  with no event saying so. `SpellStackObject.copyAsEntersDecided` is on the same list: a DECLINE
  leaves no trace on the instance, so without it the resolution re-asks forever. Both pinned by tests
  that take TWO action boundaries, because one is not enough to see it.

  ⚠️ **`paired-arms`'s identical-game skip is now WITHDRAWN for any deck containing a copier**, and
  this is a real unsoundness that was found, not a precaution. `peekCouldReadHeroLibrary` maps an
  instance id back to its pre-shuffle DECKLIST ROW and scans that card's effect refs — but a Clone's
  abilities are the COPIED card's, so a copied library-reading ETB would be invisible and the verdict
  wrong-and-confident. New `ABILITY_ACQUIRING_DEFINITION_FIELDS` names the shape; add the next field
  of it (a "becomes a copy" ability, a text-changing effect) there.

  📌 **`becameCopy` is a new public event** (OBSERVATION_POLICY classified — a copy is chosen on the
  table, and a graveyard is a public zone). **`copyAsEnters` also joined `fidelity.test.ts`'s
  behaviour signature**, the same blind spot `modal` and `characteristicPT` were added to close.

  🧠 **THE AI IS NOT INERT, AND IT DOES NOT RANK BY THE BOARD.** The generic `selectCards` path prices
  candidates with `cardValue`, which reads EFFECTIVE stats — a pilot using it copies the 1/1 wearing
  three counters over the printed 4/4 beside it and ends up a 1/1. `copyTargetValue` prices what the
  copy WOULD BE from PRINTED characteristics (body, abilities, keywords, mana source); the decline bar
  is the copier's own printed body scored the same way, which is usually zero because a Clone's own
  body is a 0/0 that dies on arrival. `copy-target-pilot.test.ts` drives the real heuristic pilot
  through all three claims, including the printed-4/4-vs-pumped-1/1 board.

  ✅ **`Kindred` (CR 308) is a real card type now, so `TYPES_WITHOUT_SYSTEM` stays honestly empty.**
  Its whole rules content is that the card's subtypes are creature types without the card being a
  creature — and that it counts as a card type in a GRAVEYARD, which is why `CARD_TYPE_BIT` (the
  exhaustive record Tarmogoyf reads) had to gain a bit. A record whose only type is Kindred still
  reports: CR 308.1 requires a second type, and the second one decides everything.

  🚫 **Reported by name, not faked.** **Copying a SPELL on the stack** (Reverberate, Narset's Reversal,
  Fork) and **TOKEN copies** (Rite of Replication, Kiki-Jiki, Twinflame) need three things this branch
  did not build: a stack object that is **not a card** and ceases to exist as it resolves (CR 707.10 —
  `SpellStackObject.resolvesTo` offers only battlefield/graveyard/exile/hand, and any of them leaves a
  phantom card in a zone that delirium, flashback and Tarmogoyf all count); an aiming moment for "you
  may choose new targets for the copy" (aiming happens at cast time or as a trigger goes on the stack,
  never for an object the engine itself just created); and the copy carrying the original's X, kicks
  and chosen modes (CR 706.10). Also reported, each with its own hint: a copy that **grants an ability
  printed in quotes** (Phantasmal Image's "becomes the target" sacrifice — the engine raises no such
  event for a data trigger; Sakashima's delayed end-step return), a copy bounded by **the amount of
  mana spent** to cast it (Mockingbird — nothing records that number), and "becomes a copy" applied by
  an **activated ability** rather than as the permanent enters (Mirage Mirror, Thespian's Stage).

  📌 **THE HINTS MOVED.** `UNSUPPORTED_HINTS` no longer lets the generic "a you may / choose template"
  hint claim copying is missing; four new hints sit above it and each names its real residual. Anyone
  re-running the coverage audit will see the copy family split accordingly — that is the fix.

  🚧 **Two things I could NOT do offline, both with named blockers.**
  1. **No curated-pool clone.** `fidelity.test.ts` joins every pool card to
     `packages/data-tools/data/card-index.json`, which is a LIVE-FETCH artifact (`npm run verify -w
     @jonny-boi/data-tools`, network) and holds 357 cards, none of them a copier. Adding Clever
     Impersonator to the pool needs that fetch. Until then the seven cards are reachable through deck
     IMPORT, which is how most of the corpus reaches the app.
  2. ~~Glasspool Mimic still reports~~ — **RESOLVED BY THE MERGE, and worth knowing as a pattern.**
     Its copy clause compiled here from the start, but the card is a modal DFC and the record's
     `layout` was not reaching `isModalDfc`, so it fell through to `SECOND_CASTABLE_FACE_GAP`.
     `feat/split-adventure` landing on main closed that half. The card needed BOTH branches and
     neither could have delivered it alone — so a coverage audit run on one branch under-counts a
     card whose two gaps are owned by two workers.

  Files owned: `packages/core` (NEW `copy.ts` + `copy.test.ts`; `card.ts`, `state.ts`, `choices.ts`,
  `events.ts`, `engine.ts`, `derived.ts`, `index.ts`, `internal/clone.ts`, `internal/zones.ts`),
  `packages/cards` (`compile/rules.ts` +1 rule & 4 hints & the parser block, `compile/compile.ts`,
  `compile/types.ts`, NEW `compile/copy-effects.test.ts`, `fidelity.test.ts` one line),
  `packages/ai` (`choices.ts`, `weights.ts`, `index.ts`, NEW `copy-target-pilot.test.ts`),
  `packages/sim` (`observation.ts` +1, `paired-arms-config.ts`, `paired-arms.ts`,
  `paired-arms.test.ts`), `apps/web` (`lib/about/mechanics.ts` +2 witnesses, `lib/play/choice-view.ts`
  +1 branch, `lib/cards.ts` +1 branch), DESIGN §3.21, COORDINATION.
- 2026-08-20 worker: `feat/step-trigger-templates` 🚧 PUSHED — **the "At the beginning of…" family,
  and the blocker that was sitting in front of all ~65 of its corpus cards.**

  **Measured offline, PAIRED against the same cached 2100-card corpus: 408 → 428 playable
  (19.4% → 20.4%), +20 cards, 0 regressions.** The twenty: Howling Mine, Kami of the Crescent Moon,
  Dictate of Kruphix, Font of Mythos, Teferi's Puzzle Box, Spiteful Visions, Scrawling Crawler,
  Stormfist Crusader, Dragonmaster Outcast, Colossal Majesty, Underworld Dreams, Fate Unraveler,
  Temple Bell, Mikokoro, Forced Fruition, Corpse Knight, Kambal, Marauding Blight-Priest,
  Poison-Tip Archer, Elas il-Kor. Half of those were in NO "At the beginning of…" bucket — the draw
  watcher and the "each player draws" body reach them.

  🔑 **THE BLOCKER WAS AN ENGINE SEAM, NOT A RULE TABLE: a trigger's resolution did not know which
  player set it off.** `who: 'any'` fires on both turns but resolves under the SOURCE's controller,
  so "at the beginning of **each player's** draw step, **that player** draws an additional card"
  would have drawn for Howling Mine's own controller every turn. `trigger-step-begins` carried an
  explicit `if (who !== 'you') return null;` saying exactly that.

  **The fix follows `feat/cast-cost-modification`'s seam rather than inventing one.** A chosen `{X}`
  rides `SpellStackObject → ResolutionFrame → EffectContext`; the triggering player now rides the
  same three hops: `PendingTrigger.triggeringPlayer` → `TriggeredStackObject.triggeringPlayer` →
  `ResolutionFrame.triggeringPlayer` → `EffectContext.triggeringPlayer`. `triggeringPlayerFor` is the
  ONE place the answer is decided (active player for a step, the drawer for a draw, the life-gainer,
  the caster, a permanent's controller for an arrival/death, `undefined` when the event is about no
  player) and it runs only for triggers that actually FIRED — the per-event scan pays nothing.

  ⚠️ **REUSED, NOT RENAMED.** Everything here is under main's existing vocabulary: `permanentEnters`,
  `permanentDies`, `endStep`, `beginCombat`, `gainLife`, `combatDamageToPlayer`, `STEP_FOR_TRIGGER`,
  `TriggerSubject`/`resolveSubject`, `excludeSelf`, `permanentFilter`, and `mayEffects` for the "you
  may" wrapper. The additions are one new event (`drawsCard`), one new field on `PendingTrigger` /
  the stack object / the frame / the context, and one new module.

  🆕 **The printed intervening "if"** (`packages/core/src/intervening.ts`), because half the family
  prints one. It is part of the trigger CONDITION, not the body, because **CR 603.4 checks it twice**:
  a false condition stops the ability reaching the stack at all (so nobody may respond to it), and one
  that has lapsed by resolution removes it doing nothing (new `triggerFizzled` event). An `if` wrapper
  inside the effects would have implemented only the second check. Two kinds ship — `sourceUntapped`
  and `controlCount` (a `CardFilter` + a count bound; `max: 0` is the printed word "no") — and a
  `minPower` bound reads **EFFECTIVE** power, because counters and anthems are what make a creature
  "power 4 or greater" on the board. `splitInterveningIf` distinguishes "no clause" from "a clause I
  cannot read", so Felidar Sovereign's "if you have 40 or more life, you win the game" REPORTS rather
  than compiling to an unconditional "you win the game".

  🗣️ **ONE "whichPlayer" vocabulary** in `effect-helpers.playersForParam`: `'controller'` ·
  `'opponent'` · `'targetPlayer'` · `'triggering'` · `'each'` (both seats, ACTIVE PLAYER FIRST — APNAP,
  fixed here so the effect is reproducible from a seed, not dependent on which seat the source sits in). `drawCards`, `loseLife` and `dealDamage` all speak it,
  so "each player", "that player" and "each opponent" mean one thing each wherever printed. Please
  extend this rather than adding a second player-selector.

  🧹 **`trigger-upkeep` was DELETED.** `trigger-step-begins` subsumed it and also handles the "you
  may" wrapper and the intervening "if", which `trigger-upkeep` silently could not — a card printing
  either would win the older rule and then fall through. One rule per concept.

  ⚡ **Rule 7: parity, measured properly.** Gauntlet seed 99 is **byte-identical** to a same-box
  `origin/main` worktree (81/280, every matchup row equal, 0 draws either side). Paired CPU time
  (`process.cpuUsage`, min-of-N, three interleaved rounds): branch/main = 1.005× / 0.888× / 1.039×,
  pooled minimum 2656 ms vs 2828 ms. ⚠️ **The wall clock on this box was, again, worthless** — the
  same 280-game gauntlet read 23.08s and 9.36s within ten minutes because another agent's build was
  running. Do not report a games/sec here.

  ✅ Enforced tables updated: `paired-arms-config.ts` classifies the new `handToBottomThenDraw`
  primitive LIBRARY-READING (it writes the whole hand into the library, and its order is chosen by a
  pilot looking at a hand the swap may have changed); `observation.ts` classifies `triggerFizzled`
  public; `internal/clone.ts` copies both new stack-object fields CONDITIONALLY, with a test that
  fails if either is dropped AND asserts an ordinary trigger still clones byte-for-byte.

  📌 **Two existing tests flipped from REFUSAL to SUPPORT** and now assert the shipped behaviour:
  `you-may-and-triggers.test.ts`'s "REFUSES each player's" and `counters-templates.test.ts`'s "each
  end step stays reported". Both refusals were correct when written; they are the thing this branch
  removed, so leaving them red-as-documentation was not an option.

  ⛔ **Reported by name, never approximated** — each is a different system, not a missing rule:
  "you win / you lose the game"; a DELAYED trigger ("at the beginning of your NEXT upkeep" — Pact of
  Negation); blink (Conjurer's Closet, Soulherder, Thassa, Teleportation Circle, Y'shtola); token
  COPIES of a permanent; ascend / the city's blessing; amass; discover; the Ring; "no maximum hand
  size"; a spell-cost increase or decrease static (God-Pharaoh's Statue, The Immortal Sun);
  "players can't activate loyalty abilities"; DOUBLING power and toughness (Unnatural Growth,
  Zopandrel); "life lost this turn" (Wound Reflection); a count derived from a REVEALED card's mana
  value (Dark Confidant, Twilight Prophet).

  ⚠️ **A PRE-EXISTING infidelity this ran into and deliberately did NOT fix, so nobody rediscovers
  it: a created token has no COLOUR.** `makeToken` builds a `CardDefinition` with no cost and
  `colorsOfDefinition` reads colour off cost pips — so "a 1/1 **black** Faerie token" and "a 5/5
  **red** Dragon token" both enter colourless and are invisible to a "black creatures you control"
  anthem or to protection from red. Every token card already in the pool has this; closing it needs a
  `colors` field on `CardDefinition` plus the colour reader honouring it. It belongs to whoever owns
  `makeToken`, not to a trigger branch — but it is the reason Bitterblossom and Ophiomancer were left
  reporting here rather than pushed through the existing token rule.

  Files owned: `packages/core` (NEW `intervening.ts` + `step-triggers.test.ts`; `triggers.ts`,
  `state.ts`, `choices.ts`, `effects.ts`, `events.ts`, `engine.ts`, `index.ts`,
  `internal/triggers-runtime.ts`, `internal/clone.ts`), `packages/cards` (`compile/rules.ts`,
  `primitives.ts`, `choice-primitives.ts`, `effect-helpers.ts`, `index.ts`, NEW
  `compile/step-trigger-templates.test.ts`, plus the two flipped tests),
  `packages/sim/src/paired-arms-config.ts` + `observation.ts` (one classification each),
  `apps/web/src/lib/about/mechanics.ts` (three witnesses), DESIGN §3.21 + the §3.11 open list,
  COORDINATION.md.
- 2026-08-20 worker: `feat/split-cards` 🚧 PUSHED — **the coverage audit's #1 and #2 gaps were one
  system, and it is four printed layouts sharing one model.** A card may carry a second half that is
  really cast, plus the list of ZONES that half may be cast from, plus — for the two halves you earn
  rather than hold — a per-instance PERMISSION. Split (CR 709), aftermath (CR 702.127a), adventure
  (CR 715) and the Siege reward (CR 310.4) are four configurations of exactly that. DESIGN §3.29 has
  the table.

  **Measured, cached 2100-card corpus, `--top 20`: 408 → 421 playable (19.4% → 20.0%).** Both headline
  gaps are gone from the ranked backlog entirely; nothing that used to report them reports a SYSTEM
  any more (the remaining split/adventure cards are blocked on ordinary rule-table templates, which
  belong to whoever is working the template families).

  ⚠️ **TWELVE OF THOSE THIRTEEN CARDS CAME FROM ONE MISSING FIELD, and it is worth knowing why.**
  `normalizeCard` never captured Scryfall's **`layout`**. Without it `isModalDfc` — which reads the
  layout and deliberately has NO keyword fallback — returned false for every modal DFC in a fetched
  corpus, all 45 fell through to the `name.includes(' // ')` catch-all, and they reported the
  castable-second-face gap they had already been given a system for. The layout is the only
  unambiguous statement of what a two-faced record MEANS (a split card and a modal DFC both print two
  faces with two costs), so it is captured verbatim and never derived. **If you are measuring
  coverage against a corpus, check the normalizer is not dropping the field your detector reads.**

  ⚠️ **THE ONE MODELLING CALL THAT WOULD HAVE BEEN SILENT IF WRONG.** A SPLIT card's own definition is
  the CR 709.4 **combined object** — both names, the union of the type lines, the SUM of the two costs
  — and its halves hang off it as `frontFace`/`backFace`. An ADVENTURER's definition is the CREATURE
  (CR 715.2), with no `frontFace` at all. Every characteristic read in the engine goes through
  `card.def`, so modelling a split card as its left half would have quietly mis-answered every discard
  filter, cost reduction and "mana value 3 or less" clause in the game while looking perfectly fine in
  a cast test. `playableFaceOf` now answers "which object am I casting?" for all three shapes, so the
  cast path stayed one shape.

  ✅ **NEW NAMES, and the existing ones I reused instead of inventing.** New on `CardDefinition`:
  `frontFace`, `backFaceCastZones`, `backFaceFreeCast`, `adventure`. New on `CardGrant`: `castFace`,
  `castFree`, read through **`castPermissionFor(state, card)`** — modelled on `flashbackCostOf`, one
  accessor that both the offer loop and the accept path ask, so a hostile client cannot cast an exiled
  card the menu would never have shown. `PlayLandAction` gained **`fromZone`**, the same field name
  and the same values `CastSpellAction.fromZone` already had. I did NOT add a new event, a new
  primitive, or a new state field: the permission is a **card grant**, so CR 400.7 (it dies with the
  object) and the per-action clone both fall out of machinery that already exists.

  ⚠️ **`spellLeaveDestination`'s `reason` argument earned itself again.** An adventure exiles its card
  when it RESOLVES and not when it is COUNTERED (CR 715.3d) — a countered adventure is an ordinary
  countered spell and the creature half is gone for good. That is the third exit-destination rule to
  live in that one function. **A hand-built stack-object literal in `alternative-costs.test.ts` had
  `card: {} as never`, which now throws** — it is a spell with no definition, and the function reads
  the face on the stack. Given a real stand-in `def` instead.

  ⚠️ **STATE-BASED ACTIONS DO NOT RUN ON A BARE PRIORITY PASS.** Cost me a debug: a battle put on the
  battlefield at zero defense and then passed on does not die. They run after a RESOLUTION. If you are
  testing an SBA, resolve something.

  🚫 **REPORTED BY NAME, NOT APPROXIMATED — and both are in the corpus, so expect to see them:**
  **FUSE** (`FUSE_GAP`, CR 702.102 — one spell that is BOTH halves, with a combined cost, two scripts
  and per-half targets that must each still be legal on resolution; that is a second shape of spell,
  not a flag on this one) and **ROOMS** (`ROOM_DOOR_GAP`, CR 714 — Scryfall files them under the
  `split` layout and they share nothing else: a permanent whose second door unlocks on the battlefield
  for its mana cost as a sorcery). **Four of the six split-layout cards in the corpus are Rooms**, so
  whoever picks up CR 714 gets most of that family. `SECOND_CASTABLE_FACE_GAP` is REWORDED rather than
  deleted: it now names the residual — a record carrying the combined `A // B` name with no per-face
  data, or a layout with no cast path at all (meld, flip). Three tests that asserted "a split card
  still reports" / "a REAL Siege stays reported" were reworded to that claim rather than deleted, so
  the catch-all keeps its guard.

  ⚠️ **THE ONLINE BOARD IS STILL FRONT-FACE-ONLY, DELIBERATELY, AND IT IS NOW A MISSING OPTION RATHER
  THAN A WRONG ONE.** `lib/online/legal-actions.ts` withholds every `face: 'back'` offer because its
  sets carry an instance id alone; for a split card that means the LEFT half is offered and the right
  is not. I did not extend it — that board's keying is another branch's test-pinned surface. The
  HOTSEAT board I did extend, to `instanceId:face`, because there the front-face-only behaviour would
  have been actively wrong: one button showing the CR 709.4 combined cost that casts the left half for
  a different price.

  ⚠️ **NO POOL CARD COMPILES AS A SPLIT CARD YET, and that is a DATA fact, not an engine one.** The
  committed `card-index.json` predates the `layout` capture (and, for Sieges, the printed-defense
  capture), so these layouts are reachable today only by importing a decklist. **I deliberately did
  not regenerate the index** — it is being regenerated on `feat/pool-expansion` and a second
  concurrent regeneration is a guaranteed conflict on the largest generated file in the repo. Whoever
  next re-fetches gets the modal DFCs, split cards and adventurers for free. `pool-mechanics.test.ts`'s
  battle reason now says exactly this instead of "the back face is cast by a path the engine does not
  have".

  📊 **RULE 7 (wall clock here is worthless — six agents):** the gauntlet is **byte-identical** to the
  branch point. `npm run sim -- gauntlet "Mono-Red Aggro" --games 40 --seed 99`, run against a
  separate same-box `origin/main` worktree (1dd5b90) and against this branch, gives the SAME SEVEN
  per-deck lines — 12/13/17/8/9/7/15 — for the same **81/280 = 28.9%**. Not "within noise": equal. The three new loops (an exile walk in
  `generateLegalActions`, an exile walk in the land loop, an exile walk in the pilot) are each behind
  **`hasCardGrants(state)`**, the same empty check every other card-grant reader starts with, so a
  game that never exiles anything under permission walks no exile zone at all; and the pilot's
  half-walk allocates NOTHING for a card with one half (`castableHalvesInHand` returns a one-element
  literal and builds the synthetic instance only for a card that actually prints two halves).

  GATE: full suite **3680 passed / 0 failed**, `npm run verify` exit 0, `npm run build` exit 0,
  measured after merging `origin/main`.
- 2026-08-20 worker: `feat/as-enters-choices` 🚧 PUSHED — **"As ~ enters, choose a creature type"
  (CR 614.1c): the naming is asked at the printed moment and REMEMBERED on the permanent, and four
  different printed lines can now read it back.** DESIGN §3.23 has the full write-up.

  **Measured offline, PAIRED against the same cached corpus on the `origin/main` this branched from:
  408 → 414 / 2100 playable (19.4% → 19.7%).** Newly complete: Adaptive Automaton, Patchwork Banner,
  Heraldic Banner, Coldsteel Heart, Vanquisher's Banner, Chronicle of Victory. The 24-game self-play
  behaviour lock is **byte-identical** (same winner, turns, actions, event-log hash and final-state
  hash on every seed), and allocation is parity: scavenge probe, 40 seeded games, 29,899 actions
  either way, branch **561 / 560** vs main **561 / 561** on paired runs.

  ⚠️ **THE PROMPT IS THE EASY HALF, AND FOUR THINGS ARE EASY TO GET WRONG HERE.**
  1. **A chosen value nothing can READ is a half-card.** The naming ships with four readers:
     `StaticAffects.ofChosenSubtype`/`ofChosenColor` (an anthem), `CardDefinition.isChosenSubtype`
     (the permanent joins the type it named), `ManaAbility.chosenColor` (a mana ability), and
     `TriggerCondition.spellSubtypeIsChosen` (a cast trigger). **Every one of them is REFUSED at
     compile time on a card with no naming line** — an anthem over a value nothing writes would
     report `'complete'` and then do nothing, which is the exact failure the contract exists to stop.
  2. **The unasked default is "nothing named", and nothing named MATCHES NOTHING.** Reanimation, a
     token, another card's "put it onto the battlefield" and a hand-built test instance all record no
     value, and every reader treats absent as the EMPTY SET rather than as "no filter". A reanimated
     Adaptive Automaton is an anthem over nobody, never over the whole board. `defaultAnswerFor`
     therefore names NOTHING rather than the first option — an arbitrary pick dressed as a default
     would hand the degraded path a working creature type.
  3. **A LAND CAN OWE TWO QUESTIONS AND ONLY ONE CHOICE CAN BE PARKED.** Multiversal Passage names a
     basic land type and *then* offers to pay 2 life; Temple of the Dragon Queen offers a reveal and
     names a colour. `raiseLandEntryChoice` is a STEP function — asks the first unanswered question,
     called again from the answer handler — rather than three independent branches, which is how the
     second one gets silently dropped. **If you add a third entry question to a land, add it there.**
  4. **DO NOT widen the `spellCast` EVENT to carry subtypes.** I did, briefly, so a cast trigger
     could read "of the chosen type" — and it broke `selfplay-lock.test.ts` on all 24 seeds while the
     winner, turn count, action count and FINAL STATE hashes were identical, because the event log is
     hashed byte for byte. The spell object already carries its subtypes; it is resolved through the
     existing `TriggerSubject` seam (`resolveSubject` now also searches the stack) and the golden
     table did not have to move.

  🧠 **THE PILOT NAMES DELIBERATELY, AND THAT IS THE DIFFERENCE BETWEEN A CARD AND NOISE.** A pilot
  naming at random still plays legal Magic — it just plays a Cavern of Souls that taps for nothing,
  and **the lab then reports "no measurable difference" about a card that is a lord.**
  `answerChooseValue` names the type on the most of the chooser's OWN cards (the deck's tribe), the
  colour their own cards demand most counted in coloured PIPS (one triple-black bomb outweighs two
  cantrips), and the OPPONENT for a player naming. It reads only the chooser's own zones — a player
  knows their decklist — and is deterministic, ties breaking on core's fixed option order.

  📌 **ENFORCED TABLES, both deliberate rather than convenient.** `OBSERVATION_POLICY` marks the new
  `chosenAsEnters` event **public**: a choice ANSWER is private to its chooser (hence the three
  redacted choice events), but a value named as a permanent enters is announced at the table and stays
  legible on the card. The option LIST — whose length is a weak read on the chooser's decklist — never
  leaves the choice, whose `choiceAsked` observation is already redacted to a count.
  `paired-arms-config.ts` classifies `chooseAsEnters` as **library-reading**, conservatively: it moves
  and reveals nothing, but its creature-type menu is built from the chooser's library, so a swapped
  card can change what is on offer and therefore what gets named.

  📌 **THE HINTS MOVED.** A printed line that mentions the named value and still fails now reports
  `a "the chosen …" READER the compiler does not recognize yet (the named value IS stored on the
  permanent; this printed line has no rule that reads it)` instead of "a you may / choose template",
  which named the wrong blocker entirely. Anyone re-running the coverage audit will see the you-may
  family shrink and a new reader family appear — that is the fix, not a regression.

  ⛔ **DEFERRED, with named blockers** (all reported by clause, none approximated): the **spend
  restriction** on produced mana (Cavern of Souls — unchanged, still the mana-pool system), **cost
  reduction by the named type** (Urza's Incubator, Morophon, Cloud Key — the cast-cost branch),
  **counter formulas** over the named type (Door of Destinies, Banner of Kinship), a **replacement
  effect on other permanents entering** (Metallic Mimic), **copying a spell** (Reflections of
  Littjara), an **extra instance of a triggered ability** (Roaming Throne), an **additional mana when
  a land is tapped** (Caged Sun, Gauntlet of Power, Utopia Sprawl), **"choose a NUMBER between 1 and
  10"** (Talion — deliberately left out of the closed subject table, because a naming no printed line
  can read is the half-card this contract forbids), **fear** (Cover of Darkness), and Multiversal
  Passage's **"this land is the chosen type"**.

  ⚠️ **ONE NAME PER CONCEPT, for the five siblings inventing vocabulary right now:** the instance
  field is `CardInstance.chosenAsEntered`, the declaration is `CardDefinition.asEntersChoice`, the
  choice kind is `chooseValue`, the primitive is `chooseAsEnters`, the event is `chosenAsEnters`, and
  the "nothing named" sentinel is `NOTHING_CHOSEN` (the empty string). If you need any of those,
  reuse them rather than coining a second spelling.
- 2026-08-19 worker: `feat/tutor-and-sacrifice-templates` 🚧 PUSHED — **the tutor family is closed for
  every destination the search primitive can reach, and a spell can now print a cost you must pay to
  cast it.** Measured offline against the same cached 2100-card corpus, same-day `origin/main`
  baseline: **408 → 446 playable (19.4% → 21.2%), +38 cards.** Suite 3676 → 3700 passed, 0 failed (192 files).
  Gauntlet seed 99 over 700 games is **byte-identical** to the same-box `origin/main` (297/700, every
  matchup row equal) — the exactness proof rule 7 wants, since wall time on this box is worthless.

  ✅ **Tutors.** `searchLibrary` gained a closed `SEARCH_DESTINATIONS` table (hand / battlefield /
  graveyard) and a `route` param; the rule table gained the unrestricted tutor, typed + union +
  colour + bounded filters, N-long land-type lists, the "basic X, Y, or Z" form, "up to N", the
  graveyard destination and the split-destination Cultivate shape. Also: "Sacrifice a land." as a
  RESOLUTION effect (it was only ever a cost before).

  ✅ **`CardDefinition.additionalCost`** — "As an additional cost to cast this spell, sacrifice a
  creature / discard a card".

  ⚠️ **THE THING TO KNOW: a mandatory additional cost is NOT a kicker, and the difference is the
  whole feature.** An optional cost may be declined, so a caster who cannot pay it casts the spell
  WITHOUT it. This one cannot: CR 601.2h makes an unpayable cost an ILLEGAL CAST. So Village Rites
  with an empty board is **not offered by `generateLegalActions` AND rejected by the cast path**, both
  from one `unpayableAdditionalCostReason` — three opinions about "can this be paid" is exactly how a
  spell becomes offerable and un-castable. Modelling it as declinable would have shipped a free
  two-card draw. It rides the EXISTING `askCostChoices` pipeline (after X/kicker/multikicker/buyback,
  the printed announcement order) rather than a rival cost system, and the payment goes through the
  same `moveToZone` funnel every other sacrifice and discard uses — which is why **paying Thrill of
  Possibility with a madness card EXILES it**. New stack field `additionalCostPaid`, copied in
  `internal/clone.ts` (without it the question re-asks and the caster pays twice).

  🧠 **The AI weighs the fetch.** A tutor answered on raw card value fetches the deck's bomb on
  turn two and sits on it — noise in every verdict. `choices.ts` discounts a searched card out of
  casting reach (`tutorReachableManaLead` / `tutorUncastablePenalty`); a DISCOUNT, not a ban, so an
  unreachable card is still fetched when nothing else qualifies. Paying a cost reads the same one
  ranking from the other end (worst qualifying permanent).

  ⚠️ **Touching `packages/sim` only as a COMMENT.** No new primitive was added, so
  `LIBRARY_READING_PRIMITIVES` needed no entry — but the reasoning is now written there: an
  additional cost is COST DATA with no nested effect refs for `allEffectRefs` to walk, and the zones
  it reads (battlefield, own hand) are ones the paired-arm runner already tracks precisely. If a
  future additional cost ever reads a LIBRARY it must withdraw the skip, and that comment says so.

  ⛔ **Deliberately NOT done, so nobody re-does it:** the shipped POOL still prints none of these
  cards. `packages/cards/data/expanded-pool.ts` + `apps/web/src/data/card-index.json` are owned by
  `feat/pool-expansion` (in flight), so adding Cultivate/Village Rites/the Landscapes would have been
  a collision. They reach players through the deck IMPORTER today; whoever next regenerates the pool
  gets ~30 new candidates for free.

  ⚠️ Still reported by name (each measured, none approximated): "a nonlegendary card" (no
  supertype field), **"with mana value X or less"** (X is a cast-time value no `CardFilter` reads —
  this is what blocks Green Sun's Zenith and Chord of Calling), a union mixing a type with a subtype
  (the filter ANDs them, so it could never find), "shuffle and put that card on top" (Sterling Grove),
  a rider on the find (Fabled Passage's "then if you control four or more lands, untap that land"), a
  derived count (Harvest Season), and on the cost side: a CHOICE of payments ("sacrifice an artifact
  **or** discard a card"), an OPTIONAL one ("you may sacrifice one or more creatures"), exile/pay-life
  costs, and any value derived from what was sacrificed (Fling, Life's Legacy, Neoform).

- 2026-08-19 worker: `feat/pool-expansion` 🚧 PUSHED — **the shipped pool is 191 → 309 cards, and
  every mechanic the compiler can build now has a card a player can actually see.** Sixteen engine
  systems had shipped with almost nothing in the pool printing them (no flashback, {X}, kicker, scry,
  surveil, mill, protection or ward; one planeswalker). Pool-only — **no meta deck was touched, so
  every recorded gauntlet baseline in DESIGN §3.4a is unmoved.**

  Method: candidate NAMES only (`expansion-candidates.json`); the compiler's `'complete'` verdict is
  the sole gate. Nothing hand-authored. Now represented: scry (23), surveil (13), mill (5), printed
  flashback (21, incl. an {X} flashback cost), {X} (10), kicker (4), modal spells (15), protection
  (8), ward (8), +1/+1 counters (11), and a 2nd planeswalker (Samut, Tyrant Smasher — the ONLY other
  walker in Magic whose every printed line compiles; I compiled all 337).

  ⚠️ **Two defects the new cards exposed** — both fixed here, both worth knowing:
  1. `addCounters` mutated `CardInstance.counters` in place. That record is the shared FROZEN
     `NO_COUNTERS` for any permanent with none, so the FIRST +1/+1 counter on anything the engine
     created threw "object is not extensible". Nine counter tests were green because every one built
     its instances by hand. If you touch counters, replace the record — never write into it.
  2. `fidelity.test.ts` kept a hand-copied list of core's target restrictions and had gone stale
     ("Destroy target artifact" failed the audit). It now calls core's `isTargetRestriction`.

  Still unrepresented, each MEASURED against every printed card with the mechanic: multikicker 0/19
  (kick-count derived values), emblems 0/90 (no emblem BODY compiles), modal DFCs 0/100 (the land
  face's pay-3-life tapland clause), battles 0/36 (Siege cast path + no defense in the index),
  indestructible + alternative costs (in flight elsewhere). They are asserted ABSENT in
  `pool-mechanics.test.ts` with their reasons, so whoever closes one gets told by the suite.

  Corpus coverage, same cached corpus: **229/2100 (10.9%)** at branch point → **307** after
  indestructible + the you-may/trigger templates → **328/2100 (15.6%)** after alternative costs. None
  of that movement is mine — this branch adds no compiler rule; I re-ran the generator after each
  merge and the pool went **309 → 331 → 357**. Indestructible, cycling, madness and buyback all have
  pool cards now, so a sibling that widens the compiler can expect me to have picked it up.

  ⚠️ **`npm run verify` does not type-check.** A generator bug emitted a long label as a
  character-indexed object; the whole suite AND verify stayed green while `npm run build` failed. If
  you touch generated data, run the build too.
- 2026-08-19 worker: `feat/mana-ability-model` 🚧 PUSHED — **core's mana model grew: four of the
  five shapes the census named are now real, and the fifth is reported by name.**
  **Measured offline, PAIRED against the same cached corpus on the same-day `main`: 328 → 384 /
  2100 playable (15.6% → 18.3%), +56 cards.** Gauntlet seed 99 is byte-identical to that `main`
  (215/700, every matchup row equal), and min-of-14 paired wall time is 2.99s vs 3.05s — noise on a
  box running several agents, with the branch faster than `main` in several individual pairs.

  ✅ **`CardDefinition.manaAbilities`** — a list of separately-printed mana abilities, each with its
  own additional **cost** (`{T}, Pay 1 life:`; the filter lands' hybrid `{W/U}, {T}:`), **rider**
  ("~ deals 1 damage to you"), **activation restriction** ("Activate only if you control an Island /
  a red permanent / three or more artifacts"), or **board-derived colours** (Reflecting Pool's "any
  type" vs Exotic Orchard's "any color" — one printed word, two different cards). It SUPERSEDES
  `produces`/`producesOptions` when present; the compiler folds a plain line in as one more entry,
  so core never has two mode lists to disagree about.

  ⚠️ **THE FOUR THINGS THAT ARE EASY TO GET WRONG HERE, and what this branch did instead.**
  1. **A mana ability is NOT an activated ability** (CR 605.3a): no stack, nobody may respond, and it
     is asked during payment planning. Expressing one as an `ActivatedAbility` that adds mana makes a
     pain land respondable AND delivers its mana one stack resolution too late to fund anything.
     `tapForMana` stayed the action; the model grew under it.
  2. **A rider is not a cost.** A pain land at 1 life is still usable, and using it kills you — so the
     damage compiles to `rider`, never to `cost.life`. Modelling it as a cost would silently make the
     land unusable at low life, which is a strictly different card. (The SBA pass now runs after a tap
     that moved a life total, so paying yourself to death ends the game there.)
  3. **An unmet restriction must make the source INVISIBLE to the payment planner**, not merely
     refuse after the fact — a planner that counts a source it cannot use funds spells that cannot be
     cast. `manaModeBlockedReason` is one answer, asked by `pushManaTapActions` and by
     `applyTapForMana`, so the menu and the engine cannot drift.
  4. **Derived colours are recomputed per query, never stored on the definition.** The mode LIST is
     fixed at six entries (`TapForManaAction.mode` has to mean the same thing to the generator, the
     planner and the apply path); availability is the board question. A derived source contributes
     nothing to another's derivation, so two Reflecting Pools read each other as empty rather than
     looping.

  ⚡ **THE HOT PATH IS UNCHANGED ON AN ORDINARY BOARD.** `planManaPayment` was deliberately built on
  dense `Int32Array` buffers (1.89×, −94% allocation; indexing the battlefield measured SLOWER — both
  results are recorded in its comments). `manaExtrasOf(def)` returns **`undefined`** for every plain
  land and rock, and the planner's cost/rider apparatus sits behind `anyTapCost`/`anyTapPain` flags
  that stay false unless a source on the board actually has one. Do not "simplify" that `undefined`
  into an array of `undefined`s. Paired throughput vs a same-box `origin/main` worktree at gauntlet
  seed 99 is byte-identical (79/280).

  🧠 **THE AI IS NOT INERT, AND IT WEIGHS THE LIFE.** `planManaPayment` now ranks pain (life cost +
  rider damage) ABOVE flexibility in its tie-break, so a Plains is spent before a pain land's coloured
  mode, and it refuses to plan a payment that reduces its own controller to 0 — a plan that kills the
  caster is not a plan (the player may still make that call by hand; the engine allows it). Because
  the preference lives in core's SHARED planner, the hotseat/online auto-tap inherits it instead of
  holding a second opinion. `packages/ai/src/mana-ability-pilot.test.ts` drives the real heuristic
  pilot through all three claims.

  ⛔ **WHAT IS NOT SHIPPED, AND WHY IT IS A DIFFERENT SYSTEM: the SPEND RESTRICTION** (4 sole, 15
  blocks — Cavern of Souls, Delighted Halfling). The other four shapes decorate the SOURCE; this one
  colours the MANA. `ManaPool` is `Record<ManaColor, number>`, so a restricted mana is
  indistinguishable from an unrestricted one the moment it lands in the pool — the POOL would have to
  carry the restriction and `payCost`/`canPay`/the planner's dense buffers/serialization/the AI's
  mana math would all have to honour it. Cavern of Souls still imports `'incomplete'` naming it.
  Two smaller residuals are also reported by name rather than approximated: a cost that **taps
  another permanent** (Springleaf Drum — a third cost component AND a choice nothing asks), and a
  colour derived from a **commander's** identity (refused for good, completion plan §5).

  📌 **KNOWN REACH LIMIT, pinned as a test rather than left to be rediscovered:** the mana half of a
  mana-ability cost is gated on the FLOATING pool — the same gate `unpayableActivationReason` puts on
  every other activated ability — so a filter land is offered once its input is floating and not
  before. That never offers an illegal action and matches how the land is played in paper, but the
  one-shot planner therefore cannot chain Island → filter land inside a single plan.

  📌 **THE HINTS MOVED.** `UNSUPPORTED_HINTS` no longer claims these four are missing systems; each
  now names the residual honestly ("a mana-ability RIDER *wording* the compiler does not recognize
  yet", "an 'Activate only if…' CONDITION the compiler cannot read yet"). Only the spend restriction
  and the tap-another-permanent cost still read as system work. **Anyone re-running the coverage
  audit will see the mana family shrink accordingly — that is the fix, not a regression.**
- 2026-08-19 worker: `feat/counters-templates` 🚧 PUSHED — **the counters-matter family**
  (mechanic-completion-plan §3c: 117 templates, 153 card-blocks). It was never a missing system:
  `CardInstance.counters`, the layer-7d stat pipeline and `addCounters` all worked and nothing
  printed could reach them. Closed as rule-table DATA plus small seam extensions.

  **Measured on the cached 2100-card corpus: 193 → 217** against the census baseline this branch
  started from, and **328 → 352 (15.6% → 16.8%)** re-measured against `origin/main` (364a4f1) after
  merging it — the counters family itself going from 116 variants / 180 card-blocks / 46 sole to
  106 / 146 / 38. Re-run with
  `node packages/cards/scripts/coverage-audit.mjs --input <corpus.json> --top 0 --json <out>`.

  Owned files: `packages/cards/src/compile/rules.ts`, `packages/cards/src/primitives.ts`,
  `packages/core/src/triggers.ts`, `packages/core/src/statics.ts`,
  `packages/core/src/internal/triggers-runtime.ts` (one line), `apps/web/src/lib/about/mechanics.ts`
  (one entry), DESIGN §3.11, plus two new test files. ⚠️ `compile/rules.ts` is the most contested
  file in the repo right now — this branch only ADDS table entries and one hint reword.

  ⚠️ **A real defect fell out of it: "~ enters with N +1/+1 counters on it" put on NO counters.**
  They are applied as the permanent enters (CR 614.1c) — while its own spell resolves, before the
  instance is on the battlefield — and `addCounters` only ever looked at the battlefield. The card
  compiled `'complete'` and then entered with none, so every 0/0 body printed that way (Stonecoil
  Serpent, Walking Ballista) died to a state-based action on arrival. Fixed.

  New engine seams (all additive, all data-driven): trigger conditions `beginCombat`, `gainLife`
  and `combatDamageToPlayer`; `StaticAffects.hasCounterKind`, which lets a static read "with a
  +1/+1 counter on it" (counters are instance state no static can change, so no layer-dependency
  loop); and the group form of `addCounters` (`each` + `scope` + the shared `CardFilter`).

  ⚠️ **ONE NAME PER CONCEPT — the merge with `feat/you-may-and-trigger-templates`.** Both branches
  independently added board-watching triggers under DIFFERENT names (`permanentEnters`/`permanentEtb`,
  `permanentDies`/`creatureDies`, and `endStep` twice). They are unified to **main's names**,
  `permanentEnters` and `permanentDies`, with THIS branch's capabilities kept under them:
  `excludeSelf` (the printed word "another" — main's rule used to refuse those lines), a colour word
  in the `permanentFilter`, an ABSENT controller tail meaning `who: 'any'` (Soul Warden), the
  landfall/constellation ability-word dresses, and the "~ or another creature dies" phrasing. Main's
  `TriggerSubject` resolver won over this branch's `TriggerStateView` (it also searches graveyards,
  which the death event needs) and this branch's `creatureDied.controller` field was REVERTED as
  redundant. The two compiler rules were merged into main's single
  `trigger-permanent-enters-or-dies`, and `beginCombat` moved into main's `STEP_FOR_TRIGGER` table.
  A both-sides play test (`counters-templates.test.ts`, "ONE event per concept") plays one game in
  which a card from each branch watches the same event and asserts both fire.

  **DEFERRED, with named blockers — do not treat these as unfinished counters work:**
  phasing (Slip Out the Back), DOUBLING counters, **proliferate** (needs a chooser over every permanent AND player with a counter; the
  choice kinds cannot express that today — reported, never approximated), counter kinds the stat
  layer does not read (charge/quest/time/growth/keyword counters), "each **attacking** creature"
  (no combat state in a `CardFilter`), "**nontoken**" filters (instances carry no token flag),
  once-per-turn trigger limiters, granting a triggered ability until end of turn, and removing a
  counter as an activation cost (`ActivationCost` has no counter component — Devoted Druid).



- 2026-08-19 worker: `fix/ai-sees-continuous-effects` 🚧 PUSHED — **the pilots were evaluating the
  PRINTED card, and now they evaluate the board.** `packages/ai` called core's `effectivePower` /
  `effectiveToughness` / `effectiveKeywords` with **no continuous aggregate in ~40 places**. A bare
  accessor answers printed + counters, so: a **Tarmogoyf evaluated as 0/0**, **every anthem was
  invisible**, **Auras and Equipment were invisible**, and `canBlockByEvasion` read `def.keywords` while
  the rules path read the granted set. Fixed by a seam, not by 40 edits: `board-stats.ts` requires the
  index, the package no longer imports the bare accessors at all, and `bare-stats.test.ts` fails the
  build if a single-argument call reappears. `tactical.ts` / `assessPosition`'s `index` went from
  optional to **required**, which is what closed the evaluator's own hole.

  📊 **BEFORE/AFTER, all re-measured on this box against a separate `origin/main` worktree, none
  estimated.** Full detail in DESIGN §3.4f.
  - **Strength: no measurable change.** Fixed vs OLD heuristic, head to head, seat+play rotated,
    paired seeds: pooled **49.9% of 9,000 games, 95% CI [48.9%, 50.9%]** — the interval straddles 50%.
    Per matchup: aggro 50.5% [48.7, 52.3]; ramp 51.3% [49.5, 53.1]; control 47.8% [46.0, 49.6], which is
    **1,435–1,436 on decisive games** and is depressed only by its 129 timeout draws (§3.4e's
    wins/**games** caveat). It ships because it is a **bug fix, not a tuning choice** — and because this
    pool contains **no anthem**, so most of what it corrects has nothing to act on yet.
  - **Gauntlet, Mono-Red Aggro, 200 games/deck, seed 4242:** 29.9% [27.6, 32.4] → **30.9%** [28.5, 33.3];
    the UW Control cell moved most (27.5% → 32.5%) and the mono-vs-mono cell is unchanged at 16.5%.
  - **`hybrid` vs `heuristic`:** aggro n=120 55.8% → **55.0%** [46.1, 63.6]; control n=80 48.8% →
    **45.0%** [34.6, 55.9]. Both still include 50%; both sides of that comparison moved together,
    because the heuristic is the hybrid's own prior.
  - **Throughput (rule 7): parity.** Allocation **93 vs 96 scavenges over 60 games** (marginally
    *fewer*); paired CPU time over the identical 4,000 captured positions, 3 runs: **0.978× / 1.009× /
    0.990×**. Parity was paid for, not assumed — the index is built AFTER the early returns that never
    read a stat, `cardValueContext` takes a prebuilt index, and the battlefield selectors became
    closure-free loops.

  ⚠️ **For whoever measures anything on this box next: wall clock here is worthless.** The same build
  read 39–87 games/sec within an hour, and a wall-clock "interleaved" comparison of two identical
  arms swung between 0.85× and 1.31×. Use CPU time (`process.cpuUsage`) or scavenge counts and pair
  everything. Two of the three re-measured tables above would have supported an entirely false claim
  if read from a single wall-clock run.

- 2026-08-19 DESKTOP-90PJPM4 (integrator): `feat/bug-reporter` ✅ **INTEGRATED** — the in-game bug
  reporter, ported from Treadlight/Lightwalker so all three projects file the SAME report. **B**, or
  the ⛬ button (the one that matters — the live PWA is used on a phone), freezes the frame from any
  view; scribble, type, speak; Submit downloads `bugreport_<stamp>.zip` with `report.md`,
  `screenshot.png`, `annotated.png`, `state_dump.txt`, `console.txt`, `voice.webm`. DESIGN §3.18 has
  the full write-up. Files owned: `apps/web/src/lib/bugreport/*`,
  `apps/web/src/components/BugReporter.tsx` + `bug-reporter.css`, plus three lines in `App.tsx`, a
  `define` block in `apps/web/vite.config.ts`, and one dependency (`html-to-image`, dynamically
  imported so it is a 13.7 kB lazy chunk, not first-paint weight).

  **Two things for whoever touches this next.** (1) `state_dump.txt` is a REGISTRY — call
  `registerStateSection('yourFeature', () => '…')` and your state is in every future report; do not
  add fields to the reporter. (2) The console/error ring is installed at APP LOAD, not when the
  reporter opens, because by then it has already missed the thing you opened it for.

  **The picture IS verified now — `npm run verify:reporter -w @jonny-boi/web`.** It drives the
  shipping bundle in the machine's own Chrome (puppeteer-core, no browser download) and asserts on
  what comes out: a real PNG the size of the viewport, thousands of distinct colours, a stroke landing
  within two pixels of the pointer, and a zip containing what `report.md` claims. It writes the PNGs
  to `apps/web/verify-out/` so a human can LOOK. This was needed because the in-app browser pane
  cannot check it at all — in a backgrounded tab `toPng` never resolves, even for one header element.

  **It immediately earned itself.** The capture was taking **8–11 s** on the Cards and Deck Builder
  views, close enough to the 12 s budget to fail at random. The cost was neither the images (0.5 s)
  nor the CSS property copying (0.4 s): the rasteriser builds a **41 MB** intermediate SVG, nearly all
  of it scrolled off the bottom. Pruning the below-fold trailing run of children — per parent, since a
  document-wide suffix is defeated by a page with columns — took **Deck Builder 10.4 s → 0.8 s** and
  **Cards 7.3 s → 0.8 s**. The `--fidelity` mode then caught what that broke: `<option>` elements have
  no box, were treated as prunable, and the sort dropdown came back EMPTY. Delta 207 against an
  anti-aliasing floor of 7 — which is why the check asserts on delta magnitude, not on where the
  pixels are (an earlier guess that measurement corrected).

  Two smaller things fixed on the way: a Puppeteer harness is two programs in one file (Node outside
  `page.evaluate`, browser inside), and lint flagged all 19 browser globals as undefined — there is now
  a targeted `eslint.config.js` block saying so. And the reporter no longer reads refs during render:
  the stroke count and "a recording is held" are mirrored into state, so it adds nothing to the
  `react-hooks/refs` debt this board tracks.

  **The rolling clip landed** (the user's ask: "cant send prior video clip leading up to pressing B").
  Not video — a rrweb DOM session recording, always on from app load, shipped as a self-contained
  `replay.html` plus `clip.json`. Video was not an option on the surface that matters: `getDisplayMedia`
  does not exist on Android Chrome, and rasterising frames costs ~0.8 s each. The replay is arguably
  better than video for this: real DOM, selectable text, and it fetches nothing when opened.

  Two things it forced, both good: the ZIP writer now DEFLATES text entries (a clip's full snapshot is
  3 MB of JSON — the first bundle with one was 15.7 MB; it is 3.7 MB now), and the harness inflates
  what it reads back, so the compressed archive is proven readable rather than assumed. The harness
  also opens `replay.html` from disk and asserts the player reconstructed the page — 4899 nodes, real
  app text — because a replay sliced off its snapshot plays as a blank rectangle and passes every
  file-exists check ever written.

  **Three defects fixed in the same pass, found by reading rather than by failing:**
  - The voice recorder's safety valve called `void this.stop()` and DROPPED the Recording. Hit the
    5-minute cap and your audio was gone, silently, with the button back at "Record voice". Now the
    valve retains and the next asker collects; a test reintroduces the bug and fails without the fix.
  - A denied microphone was stored as an empty pending recording, so every "does this report contain
    work?" test said yes and Cancel demanded a confirmation for an empty report.
  - Escape did nothing during the capture, and a capture that resolved after a cancel re-opened the
    overlay. Both fixed with a capture sequence guard. Ctrl+Z now undoes a stroke.

  **A measurement trap worth recording:** capture time looked like it had regressed from 1.4 s to
  6.6 s after the clip landed. It had not — an A/B in the same run measured clip ON at 3958 ms against
  clip OFF at 4713 ms. The machine was at 100% CPU under this session's own tooling. Measure both arms
  in the same minute or do not report the number.

  Suite **3644 passed / 0 failed** on `main` after merging `origin/main` (which brought the casting-
  cost work and the verify gate's new type-check) — this feature contributes 59 of them.

- 2026-08-19 worker: `feat/alternative-costs` 🚧 PUSHED — **cycling, typecycling/landcycling,
  buyback and madness, measured at +21 cards on the cached 2100-card corpus** (229 → 250 against
  the main this branch started from; re-measured 307 → 328 against the latest main), which
  is the census's predicted yield for this system plus one. Three things are worth reading before
  anyone touches a cost or a discard.

  ⚠️ **`spellLeaveDestination` NOW TAKES THE REASON A SPELL LEAVES THE STACK, and that argument is
  the design, not bookkeeping.** Flashback exiles a card **however** it leaves the stack; buyback
  returns it to hand **only as it resolves** and lets it go to the graveyard when it is **countered**
  (CR 702.27a). One helper answers both because two exits that can disagree is exactly the bug it was
  written to prevent — and `reason` is REQUIRED, so a new exit cannot forget the distinction exists.
  Every call site (resolution, `counterSpellOnStack`) now says which one it is.

  ⚠️ **THERE ARE TWO DISCARD FUNNELS IN THIS REPO** — core's `moveToZone` and the cards package's
  `moveOwnedCard` — and madness applies to both. They now share `discardDestination` (core's new
  `madness.ts`), so a card discarded as a COST (cycling) and a card discarded by an EFFECT
  (Thoughtseize, "each player discards") cannot disagree about being exiled. If you add a third way
  for a card to leave a hand for a graveyard, route it there.

  ✅ **Cycling is its own action kind, deliberately.** `cycleCard` indexes `CardDefinition.cycling`
  exactly as `activateAbility` indexes `activated`, but it is NOT an entry in that list: those are
  activated from the battlefield by a permanent, and folding the two teaches every battlefield-shaped
  check (summoning sickness, tap costs, `findOnBattlefield`) about a zone it never had to consider.
  **Typecycling and landcycling folded in completely** — same list, same action, effects that search
  instead of drawing — over a CLOSED table of cycling words the card filter can genuinely select; a
  word outside it reports rather than fetching approximately the right card.

  ⚠️ **The madness window is STATE, and while it stands the engine refuses everything else.** Legal
  actions are exactly: mana sources, the cast from exile, and **pass, which declines** and drops the
  card in the graveyard. Mana abilities had to stay legal or the window is a trap — the cast is only
  offered once the pool already covers the cost, so a seat with untapped lands could never fund the
  thing it was being offered. Same trap, same fix, for cycling: the pilot funds it through
  `planManaPayment` because `cycleCard` is likewise only offered once the pool covers it.

  ⚠️ **paired-arms' effect scan was blind to a new authoring place.** `allEffectRefs` walked
  `effects`/`triggers`/`activated`; a LANDCYCLING ability is a `searchLibrary` over the very library
  the two arms differ in, and it lives on `def.cycling`. Fixed. Anyone adding a new home for effect
  refs must add it there too, or the identical-game optimisation silently assumes it cannot read a
  library.

  🚫 **Reported, not faked, by name:** an **{X} cycling cost** (Shark Typhoon — an activation cost has
  no answer-and-charge step the way a casting cost does), a **madness cost printed in words**
  ("Madness—Pay six {C}" — Emrakul), a **cycling word with no expressible filter**, and **"when you
  cycle this card" triggers** (the `cardCycled` event exists for them; the trigger CONDITION does
  not). **Aftermath is not in this system at all** — it is a split card and needs the `//` type.

  GATE: `npx vitest run` **2967 passed / 0 failed**, `npm run verify` exit 0, `npm run build`
  exit 0, measured after merging origin/main THREE times mid-flight (modal-casting + keyword-sweep,
  indestructible/blocking, you-may/trigger-templates). **Gauntlet seed 99 `--games 40` reproduces
  79/280 = 28.2% BYTE-IDENTICALLY, per-deck line for line, on every run of both sides.** Throughput
  measured paired/alternating against a same-box `origin/main` worktree; the box is heavily
  contended (six agents), so the honest read is the quietest round each side — 107 vs 102 games/sec,
  ratio 0.95, with individual rounds ranging 0.44-2.65 in BOTH directions. One real cost was found
  and removed on the way: the pilot cycling policy walked the battlefield on every priority decision
  for a mechanic almost no deck holds, and now asks "does any hand card even cycle?" first.
- 2026-08-19 worker: `feat/you-may-and-trigger-templates` 🚧 PUSHED — **the "you may" and
  trigger-timing families, worked in `sole`-descending order off the cached corpus.**
  **Measured: 193 → 248 playable of 2100 (+55).** Re-runnable offline:
  `node packages/cards/scripts/coverage-audit.mjs --input <corpus.json> --top 0 --json out.json`.
  Full suite 2860 passed / 0 failed after merging `origin/main` (which brought modal casting).

  **`mayEffects` is the printed word "you may", as ONE wrapper** — confirm, then run the nested
  clause on a yes. If you are adding an optional card, do not write a primitive for it: compile the
  body and wrap it. ⚠️ **The wrapper is ordered AFTER `trigger-etb`, and that ordering is load-bearing.**
  Two body rules print their own "you may" and implement it (`returnFromGraveyard` with
  `optional: true` — Eternal Witness); letting them win first keeps one question instead of two.
  The invariant a future rule must not break: **a body rule may match a printed "you may" only if it
  implements the option.** A rule that swallowed the words and compiled the forced version would turn
  an optional card into a different one. `you-may-and-triggers.test.ts` pins it.

  **Every "you may" is play-tested BOTH ways.** Declining is the half that silently breaks, and it is
  where the bugs were: a declined search must not shuffle, a declined reveal-land must end up tapped
  with priority still on its player.

  ⚠️ **`CardDefinition.basic` is new and is NOT decoration.** The battlelands count basic lands, and
  land SUBTYPES cannot stand in — a nonbasic dual prints "Plains Island" and would be counted as
  basic, letting the land enter untapped when the printed card would not. The five curated basics in
  `data/pool.ts` declare it (they also gained their printed subtypes, which incidentally makes
  checklands see them). If you generate pool cards, the compiler emits it from the type line.

  **Reveal-lands (`entersTappedUnlessRevealed`) are modelled on the shockland, not on
  `entersTappedUnless`** — showing a card is a DECISION, not a board fact. Same contract:
  `entersTapped()` answers TRUE for them, so every path that cannot ask produces the printed
  "if you don't". A controller with nothing to reveal is not asked at all.

  **Two refusals are deliberate; please do not "fix" them by widening a rule.**
  1. **"At the beginning of EACH player's <step>"** reports. The trigger is expressible
     (`who: 'any'`), but its body almost always says "**that player**", and the engine cannot aim a
     body at the player whose step it is — a `who: 'any'` trigger would run the body for the source's
     controller every time. What is missing is the triggering player riding the resolution the way
     `xValue` and `kicked` do. Whoever builds that unblocks Howling Mine, Kami of the Crescent Moon,
     Font of Mythos, Teferi's Puzzle Box and Dictate of Kruphix in one go.
  2. **"Whenever ANOTHER creature you control enters/dies"** reports: `permanentEnters`/
     `permanentDies` have no self-exclusion, and a source that triggered off its own entry when the
     card says "another" is a different card.

  ⚠️ **`compile/rules.ts` was the contested file all day.** This branch added rules in five places
  (two enters-tapped, one reveal-land, the search-to-hand tutor, the ETB "you may" wrapper, the step
  and board triggers, and three untargeted body rules). If you merge and hit a conflict there, **keep
  both sides** — every entry is independent table data.
- 2026-08-19 worker: `feat/indestructible-and-blocking` 🚧 PUSHED — **two small engine systems,
  +23 cards measured (229 → 252 playable / 10.9% → 12.0%), suite 2872 passed 0 failed, build 0,
  gauntlet seed 99 byte-identical (79/280) at throughput parity.** DESIGN §3.17 has the full write-up.

  ⚠️ **READ THIS IF YOU EVER ADD A KEYWORD FLAG.** `KEYWORD_KEYS` in
  `packages/core/src/internal/continuous.ts` is a HAND-MAINTAINED list of the boolean flags a GRANT
  may set. A flag added to `KeywordFlags` and not to that list **works when printed and does nothing
  when granted** — silently, one-directionally, and every unit test that only exercises the printed
  form still passes. It had already swallowed a granted hexproof once; it swallowed my granted
  indestructible until a test caught it. Both new booleans are in the list now, and the comment above
  it says so in capitals.

  ✅ **INDESTRUCTIBLE is an exemption from two rules, not a shield.** The state-based-action pass now
  asks the creature-death questions SEPARATELY: 0-or-less toughness (CR 704.5f) kills an
  indestructible creature and is never gated on the flag; lethal marked damage and deathtouch
  (CR 704.5g / 702.2b) are destruction and are exempted. Sacrifice and exile still take it. The
  destroy exemption sits in `destroyPermanent` — the one function every printed "destroy" already
  passed through — so a new destroy-shaped primitive inherits it without doing anything.

  ✅ **BLOCKING: menace generalised rather than duplicated.** `minBlockers` is "can't be blocked
  except by N or more creatures" and menace is its N = 2 printing; `illegalBlockDeclaration` folds
  them by MAX. New per-pair `cantBlock` ("~ can't block" — Gravecrawler, Bloodghast, Carrion Feeder).
  ⛔ **Block REQUIREMENTS ("must be blocked if able") are NOT built and are reported by name** —
  CR 509.1c/d resolves requirements and restrictions together and that is a solver, not a check.
  Also still reported: restrictions whose selector COMPARES the two creatures (skulk, Delney) and
  filtered sets the static layer cannot read (Tetsuko) — `statics.ts` matches printed characteristics
  only, by design.

  👉 **Two generalisations other agents can reuse right now.** (1) The anthem rule
  `static-buff-your-creatures` now takes any permanent NOUN, not just "creatures" —
  `permanents/artifacts/enchantments/lands you control have KEYWORD" compiles ("permanents" maps to
  NO type filter, since an absent filter already matches everything). (2) `parseKeywordList` reads
  printed PHRASES ("can't be blocked", "can't block") as keyword names and strips a repeated leading
  verb in a conjunction, so "Equipped creature can't be blocked and has shroud" compiles. Both are
  closed tables — anything outside them still reports.

  👉 **New primitive:** `grantKeywordToYoursUntilEndOfTurn` (Heroic Intervention, Selfless
  Spirit). It targets NOTHING and reads its set off the board at resolution, which is why it is not a
  flag on the single-target grant and not a static. Classified library-safe in `paired-arms-config.ts`.

  ⛔ **Deliberately not done, with named blockers:** Gingerbrute's "except by creatures with haste"
  (needs a payload keyword listing the qualifying keywords); Access Tunnel / Secret Tunnel (a filtered
  or two-target aim core's `TargetRestriction` cannot express); Tamiyo's Safekeeping and Blacksmith's
  Skill (need a `permanent` / `permanentYouControl` target restriction — cheap, but it is core
  targeting on the hot path and belongs to whoever owns that next); Odric, Lunarch Marshal. **No pool
  cards were added** — `data/pool.ts` + the generated card index are heavily contended right now, so
  the new wordings are proven by real printed records through the real compiler in
  `packages/cards/src/indestructible-and-blocking.test.ts` instead. A pool wire-up is a clean follow-up.

- 2026-08-18 worker: `fix/keyword-sweep-and-mana-templates` 🚧 PUSHED — **the census's §2 bug is
  fixed and MEASURED: 193 → 228 / 2100 playable (9.2% → 10.9%).** Two things worth reading before
  anyone picks up the mana family.

  ✅ **The keyword-sweep defect (+34 cards, the plan's §2).** `compile.ts` reported any Scryfall
  `card.keywords` entry it "didn't consume". It had guards for ward/protection/enchant/equip/kicker/
  flashback/ability-words but not for **scry, surveil, mill**, which this compiler models as effect
  PRIMITIVES matched by rules. Opt's whole text compiled and the card was still `incomplete` because
  the word "Scry" was reported twice. Guard is evidence-based like the flashback one — skip only when
  the compiled assembly really contains the backing primitive, DEEP-WALKED (a scry lives inside an ETB
  trigger on the temples, inside an activated ability on Castle Vantress). 8 of the 12 new tests fail
  on the old compiler; the other 4 pin the honest half (a derived/conditional wording still reports,
  exactly once, naming the clause not the keyword). Recovered: Opt, Preordain, Serum Visions, Consider,
  Read the Bones, the ten Theros temples, Castle Vantress, Zhalfirin Void, the Ravnica surveil-lands.

  ⚠️ **READ THIS BEFORE TAKING A MANA TEMPLATE OFF THE PLAN.** The completion plan's §3d prices the
  mana-ability family as "52 cards for 24 rule entries, dramatically underpriced". **That is wrong,
  and the wrongness came from the hint text.** The plain forms it names — `{T}: Add {U} or {R}` and
  `{T}: Add one mana of any color` — ALREADY COMPILE on `main` (`tap-for-mana-choice`,
  `tap-for-any-color`, landed before the census was written). Everything still failing in that family
  needs **core's mana model to grow**: core models a source as a fixed list of colour bundles with no
  cost beyond the tap, no rider and no condition. This branch renames those gaps so the audit files
  them as SYSTEM work, which moves **83 sole-blocked cards** out of the template column:
  additional-cost 35 (`{T}, Pay 1 life:`, the filter lands' `{R/W}, {T}:`), rider 22 (every pain land
  + the Talisman cycle), activation-restriction 15 (the Verge cycle, Nimbus Maze, Mox Opal),
  board-derived colours 7, spend-restriction 4. **Nobody should write rule-table entries for these
  — there is no machinery behind them.** One genuine template WAS left and is closed here:
  `{T}: Add three mana of any one color` (Gilded Lotus, +1).

  📌 The pool is still untouched by this branch (it is contested). **The cheapest pool win on the
  board is now unblocked:** §6 of the plan notes the shipped pool has ZERO scry/surveil/mill cards
  *because of this bug*. Whoever owns pool expansion should add Opt/Preordain/Serum Visions/Consider
  + the temples + the surveil lands to `packages/data-tools/data/card-index.json` and re-run
  `build-expansion.ts` — they compile clean now.

- 2026-08-18 worker: `feat/battles-legend-emblems` 🚧 PUSHED — **three walker-adjacent objects:
  battles, the legend rule, and emblems.** All three DONE as subsystems; one card-level gap is
  reported rather than faked, and it is named below.

  ✅ **BATTLES reuse the attackable-object seam and did NOT touch combat**, which is what
  `feat/planeswalkers` built it for: `isAttackable` answers for battles, and
  `DeclareAttackersAction.attackTargets` needed no change. A battle enters with printed **defense
  counters** (`CardDefinition.defense` → `DEFENSE_COUNTER` via `applyEnteringDefense`, on every
  entry path, exactly like loyalty). ⚠️ **THE ONE THING THAT IS NOT LIKE A WALKER, and the only
  way to get battles wrong: a battle is defended by its controller's OPPONENT** (CR 310.11). Attack
  legality now asks `protectorOf(object)` instead of comparing controllers — which is precisely
  what makes attacking your OWN Siege legal (the printed play pattern) and lets the protector block.
  A controller comparison passes every walker test and silently makes battles unattackable. Damage
  from combat AND from burn strips defense (CR 120.3d); trample carries past the last counter to the
  defender; 0 defense is defeat by SBA. "Any target" reaches battles (CR 115.4); "creature or
  planeswalker" deliberately does not.

  ⛔ **THE BATTLE SUBSYSTEM IS COMPLETE; BATTLE CARDS ARE STILL REPORTED. Those are different
  claims, and the compiler says so per card.** Every printed battle is a Siege whose reward is casting
  its BACK FACE — the castable-second-face system a sibling owns. So `TYPES_WITHOUT_SYSTEM` is now
  **empty** (every printed card TYPE has a system) while a real Siege still imports `'incomplete'`
  naming `SECOND_CASTABLE_FACE_GAP`. 👉 Whoever lands modal DFCs: battles are waiting for you
  and need no engine work, only the reward wired to the `battleDefeated` event.

  ✅ **THE LEGEND RULE is ONE shared SBA** for legendary creatures AND planeswalkers AND battles,
  keyed on the printed **Legendary** supertype — which the compiler now parses onto
  `CardDefinition.legendary`; supertypes were parsed and thrown away before this. Three things make
  it unlike every other SBA, all pinned by tests: it is **per PLAYER, not global** (both players may
  hold the same legend quite legally); the **controller chooses**, so it PARKS a question rather than
  deciding (marked `PendingChoice.context: 'legendRule'`, so the answer routes to the rule and not to
  a resolution frame); and losers go to their **OWNERS'** graveyards. Answering re-runs the SBAs, so a
  second duplicated name cascades before anyone regains priority. ⚠️ `grantPriority` now
  declines to stomp a parked chooser — state-based actions can raise a question from inside the
  turn machine now, which was never true before. Sabotage-checked: disabling the rule fails 8 of its
  11 tests (the 3 that stay green are the does-NOT-apply cases, correctly).

  ✅ **EMBLEMS are command-zone objects nothing can remove — and that needed no enforcement
  code.** Every removal path in the engine reaches only `state.battlefield`, so an object that never
  enters it is unremovable BY CONSTRUCTION rather than by a list of exceptions somebody has to keep
  complete. Their statics/triggers are live from the command zone because `indexContinuous`,
  `aggregateFor` and the trigger collector all discover command-zone sources alongside permanents.
  The compiler's new `emblem-with-ability` rule compiles the emblem body through the ORDINARY
  static/trigger tables, so an emblem can only carry what the engine runs; a body with no rule reports
  instead of creating an inert object. ⚠️ **A TEST CAUGHT A REAL BUG BEFORE IT SHIPPED:**
  only the BULK continuous path (`indexContinuous`) knew about command-zone sources, so an emblem's
  anthem was real in combat and INVISIBLE to the one-off `aggregateFor` read — the same board
  reporting two different power values depending on which accessor a caller reached for. Both paths
  agree now, and the emblem suite pins it.

  ⚠️ **PERF, MEASURED NOT ASSUMED — read this before adding anything to a per-event
  path.** Wiring emblems in cost a real **~9% regression** (paired same-box quiet rounds 0.907 /
  0.919): the trigger collector re-walked the command zone on EVERY emitted event, and
  `for (const pid of PLAYER_IDS)` allocates an array iterator per call for a TWO-ELEMENT list. Fixed
  by reading `state.players.A/.B` directly behind a `.length` guard, and by walking the command zone
  only when its SIZE changed (sound for emblems specifically: one can never leave, and its abilities
  come from an immutable definition). Re-measured paired/alternating on the same box: **quiet rounds
  1.011 / 1.010, median ratio 1.010 — parity.** Gauntlet seed 99 stayed **byte-identical at
  79/280 on every single run, both sides, throughout.**

  ✅ **AI is not inert**: ONE attack planner weighs walkers and battles against the same power
  budget, finds battles by `protectorOf` (a controller-based search would never consider your own
  Siege), prefers the walker at equal worth (it generates value every turn it lives; a battle just
  sits there), and buys chip damage on NEITHER — on a battle chip damage buys literally nothing,
  since the reward pays only on the last counter. A test asserts the ENGINE ACCEPTS the plan the pilot
  builds, because a plan the engine rejects is the same as no plan. Hotseat and online boards render a
  defense badge beside the loyalty one, in a different colour token on purpose: both occupy the same
  slot and "3 loyalty" must not read as "3 defense".

  ✅ Enforced tables updated: `paired-arms-config` classifies `createEmblem` LIBRARY_SAFE (with
  the reason it is NOT the `ifKicked` shape — its params hold ability RECORDS, not nested effect
  refs a decklist scan would miss); `OBSERVATION_POLICY` classifies `defenseChanged` /
  `battleDefeated` / `legendRuleApplied` / `emblemCreated` public. Emblem + battle HINTS reworded to
  template gaps, and the emblem hint moved EARLY in the table — an emblem body is arbitrary card
  text, so "scry"/"choose" matched first and named the wrong blocker entirely. About page gains three
  witness-pinned entries; its TODO test now asserts landed systems read as TEMPLATE gaps.

  ❌ **Deliberately NOT done, with named blockers**: the Siege REWARD (needs the
  castable-second-face system — sibling's); "choose an opponent to protect it" is treated as
  VACUOUS rather than asked, which is exact at two seats (one legal answer, and `protectorOf` already
  gives it) but **must become a real choice if a third seat is ever added**; no battle or emblem card
  added to the curated pool or the gauntlet (no battle can compile complete until the reward lands, so
  every recorded baseline is unchanged by construction); and no `defense` in the committed Scryfall
  index — `normalize.ts` captures the field now, but the cached records predate it, so a real
  battle also reports its missing defense number until someone re-fetches. Verified: full suite
  **2762 passed / 0 failed**, `npm run verify` exit 0, `npm run build` exit 0, gauntlet seed 99
  **79/280** unchanged. Merged origin/main THREE times mid-flight (scry-and-templates,
  online-ui-parity, then graveyard-grants + derived-state), keeping both sides of every conflict —
  all four were additive (two import lists, the paired-arms classification list, and the board's own
  in-flight table + message log).
  👉 **One cross-branch integration worth knowing about**: `feat/derived-state`'s new
  `CARD_TYPE_BIT` in `packages/core/src/derived.ts` is an EXHAUSTIVE `Record<CardType, number>`, so
  adding the `battle` card type broke its build until battle got a bit. That is the table working as
  designed — Tarmogoyf counts card types in graveyards, and a type silently missing from it would
  have made him quietly smaller than printed, which is the hardest kind of infidelity to notice.
  Anyone adding a card type after me: expect that error, and give the type a bit. (Worker)
- 2026-08-18 worker: `docs/mechanic-census` 🚧 PUSHED — **the coverage audit is re-run
  against the LIVE corpus for the first time since the nine systems landed. DOCS +
  GENERATED DATA ONLY; no engine or compiler change.** Full write-up:
  **[docs/plans/mechanic-completion-plan.md](docs/plans/mechanic-completion-plan.md)**.
  - **TRUE COUNT: 193 / 2100 playable = 9.2%** (was 191 / 9.1%). Nine systems landed and
    the count moved by **two**. That is not their failure — it is the structural fact this
    plan is built on: a card is playable only when EVERY line compiles. 1070 cards are one
    gap from playable, spread across **670 different sole-blocking gaps**. There is no
    single lever left; the finish is a grind of many small closures.
  - **SYSTEMS vs TEMPLATES: 21 engine systems (259 card-blocks) vs 1665 template gaps
    (2831).** The engine is nearly done; **the compiler's rule table is the bottleneck.**
    The audit now records the split per-gap as `kind`, so nobody prices a day of engine
    work the same as a line of rule-table data again.
  - ⚠️ **TOP FINDING — a bookkeeping bug worth 34 cards, free.** Opt, Preordain, Serum
    Visions, Consider, Read the Bones, all ten scry-Temples and the surveil-lands compile
    **completely** and are then failed by the keyword sweep in `compile.ts` re-reporting a
    bare `"Scry"` / `"Surveil"` / `"Mill"` that the rules already consumed. The sweep has
    "already handled" guards for ward, protection, enchant/equip, kicker and flashback —
    but not for these three, because they landed as effect PRIMITIVES rather than keyword
    flags. Shaped exactly like the existing `flashback` guard (skip only when the printed
    line actually compiled). **193 → 227 (10.8%), a 17.6% relative gain, for three lines.**
    Left unfixed here on purpose — this branch is docs-only. **Somebody please take it.**
  - **Best template work is LANDS, by a distance:** enters-tapped templates = 26 cards for
    8 rule entries; mana-ability templates = 52 cards for 24. One entry — `{T}: Add {U} or
    {R}` — unblocks **20 cards** by itself. Meanwhile the `//` card type blocks 38 cards
    and is the sole blocker for **zero** (they all also need the cast-time face choice), and
    loyalty templates cost 38 entries for 3 cards. **Rank by SOLE-blocker count, not by
    blocks** — the raw top of UNSUPPORTED-BACKLOG.md is misleading on its own.
  - Also genuinely missing and cheap: **`indestructible` is not in `KeywordFlags`** (30
    cards, 9 sole). And **counters-matter is NOT a missing system** — counters, the stat
    layer and `addCounters` all exist; it is 117 rule entries worth 57 cards.
  - **THE BOUNDARY, stated not implied:** the genuinely-unrepresentable set is **7 cards
    (0.3%)** — 4 commander colour-identity, 1 sideboard wish, 1 dice, 1 coin flip (the last
    two refused to keep a second RNG stream out of the A/B verdicts). Multiplayer mechanics:
    **0 cards in the corpus**, nothing to build. So **done = 2093/2100 = 99.7%**.
  - ⚠️ **FOR THE POOL OWNER (I did not touch `pool.ts` — it is contested):** ten landed
    systems have **ZERO** cards in the shipped 191-card pool — printed flashback, {X},
    kicker, scry, surveil, mill, ward, protection, counter-unless-paid, shocklands — and six
    more sit on exactly one card each (Liliana, Delver, Tarmogoyf, Fatal Push, Snapcaster,
    Cryptic Command), so a user cannot build a deck around them at 4-of. The gate is
    `data-tools/data/card-index.json` (191 rows) — a card cannot enter the pool if it is not
    in the index, so the fetch comes first, then `build-expansion.ts`. Shopping list in §6
    of the plan. Note the link to the bug above: **the pool has no scry card BECAUSE of the
    sweep bug** — those cards compile and are then rejected by the expansion builder.
  - **Tool fix (in scope, stated):** the report told readers to "re-run with a larger
    `--top`" — a flag `coverage-audit.mjs` did not parse. It does now, plus `--json` (the
    COMPLETE tally, all 1686 gaps with full card lists) and `--save-corpus` (cache the fetch
    so every re-run is offline and reproducible). Every number above came from one run of
    that command; it is quoted in §7 of the plan.
- 2026-08-18 worker: `feat/modal-casting` 🚧 PUSHED — **modal spells, modal DFCs, multikicker and
  flashback's {X}/life forms — every decision a caster makes while ANNOUNCING a spell, asked before
  anybody may respond.** All four extend the cast-time seam `feat/cast-cost-modification` opened;
  none of them is a rival to it. **Cryptic Command is un-stubbed, and it was the LAST entry in
  `STUBBED_MECHANICS` — the list is now EMPTY**, so every hand-authored pool card plays as printed
  and `fidelity.test.ts` audits the whole pool with no exemptions.
  ⚠️ **THE OLD RESOLUTION-TIME `modal` PRIMITIVE IS DELETED, deliberately — do not restore it.**
  Modes are chosen at CAST (CR 601.2b) and each chosen mode is aimed at cast too (CR 601.2c). A
  primitive only ever runs during a resolution, so a primitive-based modal card *cannot help* but let
  its controller watch the opponent's response and only then decide whether to counter it — strictly
  better than the printed card, and nothing looks broken. Two rival modal systems is precisely the
  failure the seam exists to prevent, so the primitive went rather than being kept alongside
  (its `paired-arms-config` entry is replaced by a note explaining there is nothing to classify:
  chosen modes resolve as the ordinary primitives, each already classified on its own terms).
  ⚠️ **`ResolutionFrame.effectTargets` IS A PARALLEL ARRAY — splice it in lockstep with
  `effects` or you shift every later mode's target silently.** It exists because two chosen modes of
  one spell point at two DIFFERENT objects, which one frame-wide `targets` list cannot express;
  `enqueueEffects` splices both, and a test pins it. The alternative (an object per effect) would have
  changed a shape every consumer, clone and serialized state already agrees on.
  ⚠️ **A SPELL IS A LEGAL TARGET FOR ITS OWN COUNTER MODE, and that is correct.** Cryptic
  Command is an object on the stack while its own modes are aimed, so "counter target spell" can name
  it. Being faithful means the ENGINE offers it and the PILOT declines: `valueOfMode` prices each mode
  by its best legal target, and `counterSpell`'s scorer already treats countering your own spell as
  the blunder it is. Do not "fix" this by filtering the spell out of its own menu — that would be a
  rule the game does not have.
  ⚠️ **New stack-object fields go in `internal/clone.ts` (again).** `modePicks` (deep-copied
  two levels — the aims are written INTO as they are collected, so an alias lets one cast's aiming
  rewrite another's), `kickCount`, and `CardInstance.timesKicked`. Pinned by tests that drive a whole
  two-mode cast through `applyAction`, which clones at every boundary.
  • **Modal DFCs**: `backFaceCastable` beside `backFace`; `CastSpellAction.face` /
  `PlayLandAction.face` name the half. The face swap is the transform swap (`def` IS the active face,
  `printedDef` the way back), so leaving for a hidden zone reverts through the existing chokepoint
  (CR 712.8a) and a transforming DFC's back face stays uncastable (CR 712.8b). Compiler reads
  `layout: 'modal_dfc'` by LAYOUT ONLY — no keyword fallback, because guessing from a "//" name would
  sweep in split and adventure cards, which must keep reporting.
  • **Multikicker**: the answer is a COUNT, so a `chooseNumber` bounded by `maxAffordableKicks`,
  planned against new `repeatCost` (three copies of a hybrid symbol are three symbols the payer may
  satisfy in three colours — NOT a mana-value multiply). Charged once; any positive count also sets
  `kicked` so an "if this spell was kicked" rider reads it. "For each time it was kicked" is a derived
  count (`timesThisWasKicked`), so damage/draw/life/counters/tokens all learned it at once — note it
  lives in core's shared `DerivedCountName` but is answered in `packages/cards`' `intParam`, because
  it is a fact about the RESOLUTION and core's evaluator is board-only.
  • **Flashback {X} / life**: `flashbackXCost`, `flashbackLifeCost`. The X reads the FLASHBACK
  cost's count, not the printed cost's (a card may print both — tested).
  • Core gained a `'permanent'` TARGET RESTRICTION. Cryptic's bounce mode needs it: flattening
  "target permanent" to "target creature" is a card that cannot bounce a land, i.e. weaker than
  printed. The bounce compile rule now emits it too.
  ✅ **Verified**: full suite **2806 passed / 0 failed** post-merge, `npm run verify` exit 0,
  `npm run build` exit 0. **Gauntlet seed 99 reproduces 79/280 = 28.2% BYTE-IDENTICALLY** (UW Control
  12/40 unchanged too) — and that is checked, not assumed: an event scan over those same 40 UW games
  shows Cryptic Command cast 40/40 times, announcing its modes at cast every time and aiming 39, so
  the identical number is genuine rather than "the card stopped being cast". Throughput at parity,
  paired and alternating on one box (BASE 104 / 162 / 132 vs MINE 125 / 129 / 136 games/sec — the
  ordering crosses in both directions).
  ❌ **Deliberately NOT done, each with its blocker**: (1) **the two BOARD UIs offer only a modal
  DFC's FRONT face** — `castChoices`/`playableLandIds` (online) and `castOptions`/`playableLands`
  (hotseat) key their affordances on instance id ALONE, and a modal DFC is two offers for one
  instance. Rather than merge them (which would put the back face's legal targets on a menu that
  submits the front face — a WRONG action, not a missing one) both are now explicitly front-face-only,
  guarded and pinned by a test. Closing it properly means keying the affordance on `instanceId:face`
  and rendering two buttons per card; no pool card is an MDFC yet, so it would ship untested.
  (2) **split / adventure** still report `SECOND_CASTABLE_FACE_GAP`, reworded to say why: two castable
  halves on ONE object is not two faces. (3) **Flashback riders that are not mana or life** (a
  discard, a sacrifice) still report — the cast pipeline can charge mana and life and nothing else.
  (4) No MDFC or multikicker card added to the curated pool (the importer path only, as with
  shocklands), so no gauntlet baseline moves. (5) UNSUPPORTED-BACKLOG.md not regenerated (its
  coverage audit needs a live Scryfall fetch). (Worker)

- 2026-08-18 worker: `feat/derived-state` 🚧 PUSHED — **three kinds of state the engine could
  already see but could not express. Tarmogoyf and Fatal Push are both UN-STUBBED and play as
  printed.**
  1. **Characteristic-defining P/T (the star box), in CR 613.3 LAYER 7a.** `CardDefinition.
  characteristicPT` is a FORMULA over the closed derived-count vocabulary, and the layering is the
  whole point: the continuous layer — the only layer holding the state a formula needs — computes
  it into the NEW `AggregatedMod.basePower`/`baseToughness`, and the stat accessors use it **in
  place of** `def.power`. So counters (7d) and pumps/anthems (7c) add ON TOP of it, not the other
  way round. Nothing is stored, so nothing goes stale: a Tarmogoyf grows MID-COMBAT as graveyards
  fill, before state-based actions run (pinned by a test — that is the interaction a cached value
  would silently break). ⚠️ **THE ONE THING TO KNOW BEFORE YOU TOUCH STATS**: a bare
  `effectivePower(inst)` with NO aggregate answers **0** for a star creature — a formula is a
  function of the whole game and that accessor holds only the instance. Every RULES path passes an
  aggregate (combat, SBAs, serialization, and I fixed `fight` + Swords-style "life equal to its
  power" in `cards/primitives.ts`, which were bare reads). `packages/ai` still has ~40 bare reads,
  so **a Tarmogoyf evaluates as 0/0 to the pilots** — deliberately NOT fixed, because threading the
  index through those sites would ALSO make the AI see anthems and Auras for the first time and
  move every recorded heuristic baseline. It is its own change; it is named in DESIGN §3.11.
  2. **Turn-scoped fact memory** (`core/turn-facts.ts`) — a NAMED CLOSED vocabulary (revolt /
  morbid / lifegain), NOT a general event query, so the compiler can only match what it genuinely
  understands. **No new `GameEvent`**: every fact derives from events the engine already emits, fed
  from the emit chokepoint the trigger collector uses. Cleared as a turn BEGINS (not at cleanup), so
  "this turn" still reads true during the previous turn's end step. Fatal Push's
  `{ base: 2, revolt: 4 }` switch is read at **RESOLUTION** — a fetchland cracked in response turns
  revolt on, which a cast-time read would miss — and it is the CASTER's fact, tested against the
  opponent losing a permanent instead.
  ⚠️ **PERF, measured not guessed**: storing the facts as a `{ A, B }` record cost **~3% of sim
  throughput**, because that is one allocation PER CLONE and the engine clones the state at every
  action boundary. They are two flat optional NUMBERS on `GameState` now (`turnFactsA/B`, bitmasks,
  always accessed through the helpers) and throughput is back at parity. Same trap as the frozen
  `NO_COUNTERS` record — anything you add to `GameState` or `CardInstance` is on the clone path.
  3. **Coloured/filtered statics.** `CardFilter.anyOfColors`, read from cost pips (hybrid included)
  by `colorsOfDefinition` — which MOVED from `protection.ts` to `card.ts` (re-exported, so no call
  site changed) because `choices.ts` importing protection cycles through the continuous layer. It is
  honoured inside `matchesCardFilter` itself, so it reaches EVERY consumer — searches, discards,
  sacrifices, attachment hosts — not just anthems, which is what the brief asked to verify.
  👉 **Compiler**: the blanket `*` P/T refusal is now compile-WHEN-MATCHED, refusal otherwise (a
  formula outside the closed vocabulary, or whose halves count different things, still reports by
  name). `text.ts` gained `joinRevoltRiders`, the same precedent as `joinModalBlocks`: an
  ability-word line MODIFIES the line above it, so ONE rule sees Fatal Push's whole idiom instead of
  two halves that would destroy twice. New `ABILITY_WORDS` set (CR 207.2c — an ability word has no
  rules meaning of its own) so Scryfall listing "Revolt" as a keyword stops being reported one line
  after implementing it; the skip is CONDITIONAL on the labelled line having compiled.
  ❌ **Deliberately NOT done, with blockers**: the AI evaluation gap above; P/T formulas outside the
  closed count vocabulary (reported, never guessed); no new pool cards beyond the two un-stubbed;
  no gauntlet deck runs Tarmogoyf or Fatal Push, which is WHY the baselines are untouched;
  UNSUPPORTED-BACKLOG.md not regenerated (needs a live Scryfall fetch).
  ✅ **Gate**: full suite **2649 passed / 0 failed** (baseline 2621 + 28 new), `npm run verify`
  exit 0, `npm run build` exit 0; gauntlet seed 99 **79/280 = 28.2%, byte-identical** to the
  recorded baseline; throughput at PARITY against a same-box `origin/main` worktree, 8 alternating
  paired rounds (median ratio 1.20 in my favour, mine faster in 6/8 — the box was heavily contended
  this wave, baseline swinging 28–103 games/sec, which is exactly why the comparison is paired and
  why I claim parity rather than a speedup). Three tests that PINNED the old refusals were flipped
  (Tarmogoyf's compile exemption, the "partitions a mixed list" blocked card, the coloured-anthem
  refusal), each with a NEW refusal test in its place so the honest half still fails loudly.
  (Worker)

- 2026-08-18 worker: `feat/online-ui-parity` 🚧 PUSHED — **three shipped mechanics stopped being
  invisible online.** Planeswalker attacks + loyalty abilities, flashback (casting from the
  graveyard) and cast-time {X} questions were all in the server's `legalActions` with NO affordance on
  `OnlineBoard`, so a networked player could not use any of them — the repo's "an inert feature is not
  done" rule, failed three times over. Parity is by SHARING, never re-implementing: the online board
  now renders the same `SeatPanel`/`ChoicePrompt`/`AbilityPrompts`/`GraveyardPanel` the hotseat does,
  and both boards derive affordances from the same pure modules — `legal-actions.ts`
  (`graveyardCastChoices` splits casts BY ZONE; `abilityChoices` is the online twin of the session's
  `abilityOptions`, grouped from server offers alone so no dead buttons), `auto-tap.ts`
  (`graveyardCastableWithTaps` + `castSequence(..., 'graveyard')`, which plan the FLASHBACK cost, not
  the printed one) and the new `lib/play/graveyard-cast.ts` (`graveyardPanelView` — the panel's whole
  view-model, why-disabled copy included). Casting goes through ONE chokepoint per board,
  `activateCard(id, zone)`, so click, drag-to-play and the graveyard panel cannot diverge.
  ⚠️ **Three traps for whoever touches this next.** (1) `CastSpellAction.fromZone` must survive the
  round trip: casts are grouped by zone and the zone is echoed on submit — a graveyard cast that
  forgets it is looked for in the HAND and cleanly rejected, which looks exactly like a dead button.
  (2) Auto-pass has to count graveyard plays (`tapCastableCount` now adds `graveyardTapCastable`), or
  the board advances past the only windows a flashback is castable in. (3) A greedy test driver that
  taps whenever it can will hide these features rather than prove them — mana empties at the END OF
  EVERY STEP, so tapping in upkeep leaves the main phase with an empty pool, a tapped board, no
  fundable flashback and max X = 0. The pilot in the harness taps only in its own sorcery window.
  **Masking needed nothing**: loyalty is public (it lives in the instance's counters and
  `maskStateForSeat` copies the battlefield wholesale) — now PINNED by protocol tests asserting the
  walker, its loyalty and its ability list survive for BOTH seats and for a spectator.
  **Verified LIVE, not just unit-tested**: `apps/server/src/online-ui-parity.test.ts` drives the real
  `Room` with two fake-connection clients through real games and asserts the very client functions the
  board renders from — an Elves attacks Liliana via `buildDeclareAttackersAction` (loyalty drops, B's
  life does not move), a `+1` loyalty line is offered by `abilityChoices` and moves loyalty 3→4, a
  flashback spell is cast out of the graveyard via `castSequence(..., 'graveyard')` and ends in EXILE
  (CR 702.34a), and an {X} cast surfaces `chooseNumber` to the CASTER while the opponent gets only the
  redacted waiting line. All four sabotage-checked RED→GREEN.
  ❌ **NOT done, and why:** the shipped pool has NO card with flashback, {X} or kicker (the sibling
  branches that built those systems added no pool data — importer path only), and a `DeckList` can only
  name cards the server's pool knows, so those two harness games are dealt from
  `loadCardPool({ extraCards })` through a NEW optional 4th `Room` constructor param (default
  unchanged; production always takes the shared pool). 👉 **If you add a flashback/{X}/kicker card to
  the pool, drop the injected pool from that test and deal it for real.** Also not done: no
  drag-to-play FROM the graveyard (click only — the drop-zone gesture is hand-specific and a second
  drag source would need its own affordance study); kicker/pay-life prompts online are covered by the
  same `ChoicePrompt` path as {X} but are NOT separately harnessed (no pool card asks them); no online
  spectator affordances (spectators still correctly get no action menu). Full suite **2628 passed /
  0 failed** on the branch alone (baseline 2621 + 7 new); after merging origin/main
  (scry-and-templates) **2651 passed / 0 failed**, `npm run verify` exit 0, `npm run build` exit 0.
  (Worker)
- 2026-08-18 worker: `feat/graveyard-grants` 🚧 PUSHED — **effects can now TARGET and MODIFY cards
  in graveyards, and Snapcaster Mage is UN-STUBBED.** Two systems, built together because neither is
  worth anything on its own.
  **(1) Targeting a graveyard card**: `TargetRestriction` gained
  `'instantOrSorceryInYourGraveyard'`, threaded through the SAME three enforcement points as every
  other restriction — offer (`legalTargetsFor`), accept (`isLegalTarget`), and the primitive's
  re-check at resolution — so a target that leaves the graveyard in response FIZZLES the ability
  instead of granting into the void (pinned at core AND through a real game). It reads "your" off
  the ACTING player exactly as `'opponent'` does, and an absent controller makes every candidate
  illegal rather than guessed. Hexproof/shroud/protection are deliberately NOT consulted here:
  they read "this permanent", and a card in a graveyard is not one (CR 110.1).
  **(2) Continuous effects on non-battlefield cards**: a NEW `GameState.cardGrants` list
  (`packages/core/src/card-grants.ts`) — NOT the continuous layer, whose index is keyed on
  battlefield permanents, whose statics radiate from battlefield sources, and whose
  `pruneOrphanContinuousEffects` would have deleted a graveyard grant on sight. A grant is
  instance-scoped, expires in cleanup, and dies with a zone change (CR 400.7) at every zone-move
  chokepoint — core's `moveToZone`, the cast's graveyard→stack move, and `cards`'s own
  `moveOwnedCard`/`movePermanentTo` funnels, which had to agree or a regrown card would carry a
  stale grant.
  ⚠️ **THE TRAP WORTH KNOWING**: pruning the grant as the card leaves the graveyard sounds like it
  must break flashback's EXILE, and it does not — that replacement rides the stack object's own
  `castFrom` (`spellLeaveDestination`), never the grant. CR 400.7g's "the effect keeps applying to
  the spell it becomes" therefore falls out of state that already exists instead of being stored.
  Pinned by a test that casts on a grant and asserts the card lands in EXILE with no grant alive.
  **One accessor, `flashbackCostOf`**, answers printed-or-granted for `generateLegalActions`,
  `applyCastSpell` AND both pilots — a pilot reading only `CardDefinition.flashback` would cast
  Snapcaster and never use it, which is exactly the "legal but inert" failure the flashback branch
  warned about.
  ⚠️ **PERF, measured the only way that works on this box.** `cardGrants` is OPTIONAL and absent in
  every game that grants nothing, and every reader and pruning hook opens with the same
  one-property empty check as `isLegalTarget`'s `state.continuous.length === 0` fast path. Wall
  clock here is **worthless**: five agents share the machine and paired alternating gauntlet runs
  swung 0.64x–2.25x in BOTH directions. Parity was established instead with the allocation
  instrument `engine-alloc-bench.ts`'s own header prescribes but which had never been shipped — a
  scavenge-count probe, now added as `packages/core/bench/scavenge-probe.ts`. Result: **534 vs 533
  median scavenges** against a same-box origin/main worktree (that header documents ±2 as the noise
  floor), with **byte-identical play** — 30,466 actions / 63,782 events on both — and
  `cloneState`/`planManaPayment` micro-benches level or slightly favouring the branch. Gauntlet
  `Mono-Red Aggro --games 40 --seed 99`: **79/280 = 28.2%, byte-identical**, before AND after the
  origin/main merge.
  **Snapcaster Mage un-stubbed**: its real Oracle text compiles `'complete'` via a new
  `grant-flashback-to-graveyard-spell` rule. The "The flashback cost is equal to its mana cost"
  sentence is part of the SAME idiom on purpose — without it the line never prices the recast, and
  a free recast is strictly better than the printed card, so that shape still reports. The curated
  pool carries the whole card.
  👉 **Adding `flash` to the pool entry moves NO recorded baseline**: no meta deck runs Snapcaster
  (UW Control cut it precisely because it was a blank 2/1), and seed 99 reproduces byte-identically.
  Putting it BACK into a deck is still an integrator call with a re-measure attached — the deck's
  own comment now says exactly that instead of claiming the card is unimplemented.
  **The AI is not inert**: `valueOfEffects` gained a `grantFlashback` entry pricing the grant off
  the card it names (new weight `grantedFlashbackValueShare` = 2/3 — below `returnFromGraveyard`'s
  full value, because the grant expires at end of turn and the card still costs its mana), so the
  trigger's target chooser aims at the BEST spell rather than the first offered.
  `graveyard-grant-pilot.test.ts` drives the heuristic through the WHOLE loop — it casts the
  creature, the engine resolves the ETB, and the pilot then takes the recast — plus a control
  proving it constructs no graveyard cast when there is no grant.
  Classified in both enforced tables: `grantFlashback` is LIBRARY_SAFE in paired-arms-config (it
  reads a PUBLIC zone the runner already tracks exactly, and branches on nothing a library holds),
  and `cardGrantAdded`/`cardGrantExpired` are public in observation.ts (a graveyard is public and
  the granting ability resolved in front of the table). Two stale hints reworded (flashback and
  graveyard both claimed "missing" for things that now exist), About gained two witness-pinned
  entries, and the stale Snapcaster row is gone from UNSUPPORTED-MECHANICS.md.
  **NOT done, deliberately, with the blocker named each time**: no OTHER stubbed card un-stubs
  through this seam — all three remaining were checked and none is blocked on graveyard targeting
  (Tarmogoyf: characteristic-defining P/T; Fatal Push: revolt's turn-scoped event memory; Cryptic
  Command: modes chosen at cast). No graveyard-HATE template (a Surgical-style "exile target card
  in a graveyard" needs targeting ANY card in EITHER graveyard — a second restriction — plus an
  exile primitive that reaches a non-battlefield zone; the targeting half is now trivial, but
  shipping half of it would report a card that then plays wrong, so it is left named rather than
  half-built). No play-UI affordance for a granted recast (the actions ARE in `legalActions`; same
  open follow-up printed flashback already carries). UNSUPPORTED-BACKLOG.md not regenerated (that
  audit needs a live Scryfall fetch). Merged origin/main (scry/surveil + six templates) — clean
  auto-merge, both sides kept. Full suite **2673 passed / 0 failed**, `npm run verify` exit 0,
  `npm run build` exit 0 — all re-run AFTER the merge. (Worker)

- 2026-08-18 worker: `feat/scry-and-templates` 🚧 PUSHED — **scry and surveil play as printed, and
  the Temple / surveil-land cycles compile.** The blocker DESIGN §3.11 named ("bottom-of-library
  placement has no primitive") turned out not to exist: `moveOwnedCard`'s `'bottom'` position has
  been the funnel all along, so what was actually missing was the QUESTION. It is one ordered
  `selectCards` over the top N with `min: 0` and a new `SelectCardsRequest.keepOnTop` marker —
  offering the candidates IS the look (the `transformRevealTop` precedent: a choice travels to its
  chooser alone), the picked cards stay on top in the picked order, every unpicked one leaves.
  Scry asks a SECOND question for the bottom ORDER, and only when 2+ cards are going down; surveil
  asks once (a graveyard has no order). **Both collect every answer before moving a single card** —
  the ask-first contract, which is what makes a parked scry replay safely.
  ⚠️ **Redaction, since this is the branch that could have leaked.** New `cardsLookedAt` event =
  player + COUNT, nothing else, so it is public exactly as a spectator watching somebody pick up
  two cards is; the identities never leave the choice, whose `choiceAsked` observation was already
  redacted to an option count. Surveilled cards land in a graveyard and emit a PUBLIC `zoneChange`
  (right — they are placed face up); bottomed/kept cards move library → library and are anonymised
  by the existing hidden-zone rule. `scry`/`surveil` are LIBRARY_READING in `paired-arms-config`:
  they read the top and BRANCH on it, the `revealTopCard` shape.
  **AI policy, documented, deliberately one rule with one weight** (`scryKeepValueThreshold`): keep
  every looked-at card whose `cardValue` clears the bar, bottom/bin the rest, survivors best-first.
  It works because `cardValue` already prices a land by whether its controller still NEEDS lands —
  threshold between `choiceLandValue` (2) and `choiceLandShortValue` (20) — so the pilot bottoms
  lands exactly when flooded and keeps them while short. Tested both directions on the same card.
  **Templates CLOSED** (each: a real card compiling `'complete'` with pinned params AND an engine
  play test — `compile/scry-surveil.test.ts`, 16 tests): `Scry N`, `Surveil N`,
  `Scry/Surveil N, then EFFECT` (Preordain), `When ~ enters, scry 1` on an enters-tapped land
  (Temple of Epiphany — tapland + ETB scry + dual mana, all three lines), the surveil-land shape
  (Undercity Sewers), and `Counter target spell unless its controller pays {X}` (Condescend, which
  needs BOTH halves at once). Failure modes are first-class tests: library shorter than N, keeping
  nothing, keeping everything, and the chosen ORDER reproduced exactly in both directions.
  **NOT done, with the real blocker named**: "deals X damage DIVIDED as you choose among any number
  of targets" (Fireball's real text) needs divided targeting — one spell, several targets, each with
  its own share — which the targeting layer cannot express; a conditional scry ("if you control an
  artifact, scry 2") needs a condition reader; a scry rider whose TAIL chooses its own target has no
  moment to choose it (refused, tested). Multikicker, modal, MDFC, emblems, battles, legend rule,
  graveyard grants, dynamic P/T, revolt and colored statics are siblings' this wave — untouched.
  UNSUPPORTED-BACKLOG.md NOT regenerated: the coverage audit needs a live Scryfall fetch and no
  local corpus is committed, so the delta needs the integrator. For what it is worth the committed
  backlog names `When ~ enters, scry N` (14 cards) and `When ~ enters, surveil N` (12 cards) as
  distinct gaps, both of which these templates address — unverified until the audit re-runs.
  Verified: full suite **2644 passed / 0 failed** (baseline 2621 + 23 new), `npm run verify` exit 0,
  `npm run build` exit 0, gauntlet seed 99 **79/280 = 28.2% byte-identical to main's baseline** (no
  scry card is in the gauntlet, so identical is the right answer). Throughput at PARITY on a noisy
  shared box, measured paired: 10 alternating rounds against an origin/main worktree, median
  **184.5 vs 171 games/sec** (both arms swing 120–202, which is exactly why the comparison is
  paired and read as a median). (Worker)

- 2026-08-18 worker: `fix/scan-real-photo` 🚧 PUSHED — **the deck-photo scanner now reads the user's
  REAL photo** (16 sleeved piles / 59 cards, fanned on dark cloth), which the fanned-piles feature —
  verified only on synthetic images — failed badly on: doubled card width, 20 piles instead of 16, 44
  cards instead of 59. **Root causes, measured off the photo, all in `apps/web/src/lib/scan/`**:
  (1) column bands MERGE when piles sit shoulder to shoulder, so "median band = card width" picked a
  multiple — replaced by `estimateTileExtent` (`detect.ts`): the tile size that explains every band as
  whole multiples, residual ties to the LARGER (harmonics also tile). (2) Copy counting by
  variance-stripe rhythm cannot see sleeved copy boundaries (glare + jpeg noise make the dark line
  between copies as "busy" as a title bar) — counting is now by BRIGHTNESS: one pale **title plate**
  per copy (`titlePlates`/`countCopies`, `stacks.ts`), guarded against pale art (photo-global fan
  pitch — every pile fanned by one hand), nearly-flush copies (deep-valley escape), sleeve-rim glare,
  and black borders sunk into dark cloth. All 16 piles count EXACTLY right, not merely sum right.
  (3) OCR at phone resolution: nearest-neighbour upscale → **bilinear** (`crop.ts`), Tesseract
  single-line → **block** mode (`ocr.ts`), and the matcher scores each OCR line and each contiguous
  word-run separately, ties to the longer-evidence query (`match.ts`) — 15/16 names resolve exactly;
  the one miss (Gatecreeper Vine, glare-buried title) is LOW-CONFIDENCE and flagged for review.
  **The fixture pins it**: `fixtures/user-deck-photo.jpg` + `real-photo.test.ts` assert 2×8 piles, the
  exact per-pile count vector, 59 total, ≥14/16 names via REAL Tesseract, and every miss flagged
  non-confident (eng.traineddata caches into fixtures/, gitignored; first run downloads ~5MB).
  Sabotage-checked RED→GREEN. Stripe-rhythm unit tests rewritten to the plate counter; DESIGN §3.12
  updated. Full suite 2513 passed / 0 failed; `npm run verify` exit 0; `npm run build` exit 0.

- 2026-08-18 worker: `feat/planeswalkers` 🚧 PUSHED — **planeswalkers are real: loyalty
  counters, walkers as attackable objects, Liliana of the Veil un-stubbed.** Loyalty lives in the
  EXISTING counters record (`counters['loyalty']`); every entry path shares `applyEnteringLoyalty`.
  Loyalty abilities are activated abilities with a SIGNED `cost.loyalty` — sorcery-speed, engine-
  enforced once per walker per turn (compared against `turnNumber` via a conditionally-cloned
  `CardInstance.loyaltyActivatedTurn`; anyone adding instance/combat fields: `internal/clone.ts`,
  as ever), never payable below zero; paying to exactly 0 kills the walker immediately and the
  ability still resolves. ⚠️ THE COMBAT SEAM IS GENERIC ON PURPOSE (the brief's battle
  constraint): `DeclareAttackersAction.attackTargets` maps attacker → attacked PERMANENT, gated on
  core's `isAttackable(def)` — battles plug in there without touching combat again. Damage to a
  walker removes loyalty (CR 120.3c); trample past its loyalty carries to the player (CR 702.19i);
  an attacked walker that leaves absorbs nothing and redirects NOTHING (the 2017 rules removed
  redirection — do not "add it back"). Targeting: `'playerOrPlaneswalker'` + `'creatureOrPlaneswalker'`
  restrictions; "any target" includes walkers (Lava Spike / Sorin's Vengeance refreshed in the
  GENERATED expanded pool by targeted patch — full `build-expansion` re-run is blocked on the
  gitignored scratch cache, which no machine currently has; the fidelity suite recompiles both from
  real text so the data provably matches the compiler). Compiler: `planeswalker` left
  TYPES_WITHOUT_SYSTEM; `+N:`/`−N:` lines compile via `compileLoyaltyAbility` (U+2212 minus
  handled); a walker record without printed loyalty stays reported (the committed data-tools index
  predates loyalty capture — `normalize.ts` captures it now; Liliana's cached record got the one
  factual field). New primitives `sacrificeChosen` (edict — the VICTIM picks) and
  `pileSplitSacrifice` (two questions, both collected before anything moves); `discardCard` grew
  `who:'eachPlayer'` (APNAP). Emblems: NOT built — new `/emblem/` hint, checked before the
  loyalty hint so ultimates report the real blocker. Legend rule: NOT built for walkers because the
  engine has none for legendary creatures either — building it walker-only would be a partial rule;
  it needs one shared owner. AI is not inert: the heuristic activates loyalty abilities (priced by
  `valueOfEffects` + new `loyaltyAbilityBaseScore`/`loyaltyPerCounter` weights), diverts the
  smallest sufficient attacker set to KILL a finishable walker (never chips, never over a lethal
  race), burns killable walkers; the hybrid's policy candidates carry the same walker attack plan
  plus the all-face alternative. Coverage audit re-run post-merge: **191/2100 playable (9.1%)**,
  the "planeswalker loyalty abilities" system block (30 cards) dissolved into per-template gaps.
  Merged origin/main (protection/ward + template-gaps + flashback + DFC) — rules.ts hint table and
  sim fidelity caveats were 3-way rewordings, all kept. NOT done: online board UI for walker
  attacks (hotseat only; the server passes `attackTargets` through untouched — deep action validity
  is the engine's), no walker added to gauntlet meta decks (verdicts unchanged by construction),
  emblems/battles. (Worker)
- 2026-08-18 worker: `feat/cast-cost-modification` 🚧 PUSHED — **cost modification at cast time:
  {X} costs and kicker play as printed.** The subsystem the 2026-08-15 board note names as gate #3
  exists now; suspend/spectacle are rule-table work on top of it. The seam: casting a spell whose
  definition carries `xCost` (count of printed {X} symbols — NOT part of `ManaCost`, X is 0 off
  the stack per CR 107.3) or `kicker` parks a cast-time question with nothing resolving, exactly
  like a shockland's pay-life. New choice kind `chooseNumber` ("choose a value for X", range
  0..max computed by the ENGINE from the same `planManaPayment` that will fund it — an unpayable
  X is never offered, X capped at 0 / an unaffordable kicker never stop the game); the kicker
  question is the existing `payMana`. ⚠️ THE ENGINE CHARGES, ONCE, in `applyAnswerChoice` —
  same rule as optional payment. The chosen values ride `SpellStackObject.xValue`/`kicked`
  (marker: `awaitingCastChoice`, cleared per answer; **all three fields added to
  `internal/clone.ts` — field-by-field cloning drops what you forget**) into
  `ResolutionFrame` and `EffectContext.xValue`/`kicked`, so "deals X damage" reads the paid-for
  number AFTER the spell left the stack (tested). Compiler: {X} symbols compile into `xCost`
  (Phyrexian/monocolour-hybrid still report, message reworded), `^kicker {COST}$` →
  `CardDefinition.kicker`, new EFFECT_RULES `x-damage`/`x-draw`/`x-gain-life` (gated on the cost
  actually printing {X} — a "where X is…" X is refused, not misread), `kicked-damage-instead`
  (Burst Lightning / Shivan Fire, one dealDamage with `{base, kicked}` amount) and
  `kicked-extra-effect` ("If this spell was kicked, RIDER" → new `ifKicked` branch primitive,
  rider compiled target-free and enqueued into the same resolution). Real cards proven end to
  end: Blaze, Mind Spring, Burst Lightning (kicked 4 / unkicked 2 / poverty-unkicked) —
  `cast-cost-cards.test.ts`. AI: `chooseNumber` answered max-on-gain (the engine parks X as
  'gain'), min otherwise; the heuristic scores an X burn at the X THIS board could fund
  (projected from `totalAvailableMana` minus base cost; X=0 casts are held). `ifKicked` is
  classified LIBRARY_READING in paired-arms-config ON PURPOSE: its nested refs hide inside a
  param where the decklist scan cannot see them, so the identical-game skip is withdrawn for
  kicked resolutions — sound whatever the rider contains. Hints reworded: kicker → template-gap
  wording, multikicker split out as its own system, {X} hint → template-gap wording, cycling/
  buyback/madness keep a real-system hint. About page gained "{X} costs" + "Kicker" (witnesses:
  `x-damage`, `kicker-cost` rule ids). UNSUPPORTED-BACKLOG regenerated: still 178/2100 — honest:
  the corpus's X staples (Walking Ballista, Exsanguinate, Finale…) are blocked by OTHER systems
  (counters/activated, group drain, tutors), so the system unblocks importer-path cards, not the
  EDHREC top slice. NOT done, deliberately: multikicker (needs a pay count — reported), kicked
  ETB clauses on permanents (kicked flag dies with the resolution; needs instance memory), X
  divided among targets (real Fireball still reports), Phyrexian, no pool additions (importer
  path only, like shocklands), and none of the 7 stubbed famous cards un-stub via this seam
  (checked: their blockers are transform/flashback-timing/sacrifice-activated/dynamic-P/T/
  loyalty/revolt/modal-at-cast — all named, none is cast-time cost choice). FOLLOW-UP for
  whoever owns flashback: its {X}/additional-cost flashback forms were reported pending THIS
  system — they can now be wired to the cast-time question step. (Worker)

- 2026-08-18 worker: `feat/source-aware-targeting` 🚧 PUSHED — **protection from [quality] and
  Ward {N} play as printed, on a source-aware targeting seam.** `isLegalTarget`/`legalTargetsFor`/
  `illegalTargetReason(ForEffects)` gained an optional trailing `source?: CardDefinition` (additive
  — old call sites compile unchanged); the engine passes it at offer, accept, trigger-aim and the
  three resolution re-checks. All FOUR protection halves enforced (targeting, damage — combat +
  noncombat with a new `damagePrevented` event, enchant/equip via `isLegalHost` + SBA knock-off,
  blocking). Ward is engine-raised at the three targeting moments and resolves through the existing
  `payMana` optional-payment machinery via core's reserved primitive id `wardCounterUnlessPaid`
  (registered in cards; classified LIBRARY_SAFE in paired-arms-config). Compiler reads `Ward {N}`,
  `Protection from X[ and from Y]`, and the gains-protection-until-EOT grant; UNSUPPORTED_HINTS
  reworded to a template-gap. **TRAPS found:** (1) `internal/continuous.ts` `grantInto` only folded
  the 10 combat keywords — granted hexproof/shroud/menace/unblockable/flash were silently dropped
  for as long as the layer has existed (targeting.ts documented them as working); fixed + pinned.
  (2) The keyword merge `{...printed, ...granted}` would have REPLACED a printed protection list —
  payload keywords need union/add semantics, now in one place (`mergeKeywordGrant`, exported).
  (3) `heuristic.ts`'s `defaultLegalTarget` picked the biggest threat with NO legality check — a
  hexproof (now also protected) fallback target meant a rejected cast and a re-chosen identical
  goal; it now filters through `isLegalTarget`. NOT done, deliberately: attachments/statics may not
  grant ward/protection (compiler refuses — the continuous-empty fast path cannot see them);
  "any target" spells stay unpoliced at cast (hexproof precedent — they fizzle at resolution);
  non-generic ward costs and off-table qualities report; UNSUPPORTED-BACKLOG.md not regenerated
  (network tool). Suite green, `npm run verify` exit 0, build exit 0; gauntlet seed-99 reproduces
  79/280 = 28.2% exactly; throughput at PARITY against a same-box origin/main baseline worktree,
  alternating runs (quiet-box rounds: 97.0 vs 95.9, 90.8 vs 91.9, 100 vs 96.5 games/sec — median
  ratio ~1.01; absolute numbers below the recorded 109–118 band because several agents shared the
  box, which is why the comparison is paired). (Worker)
- 2026-08-17 worker: `feat/template-gaps` 🚧 PUSHED — **six importer template gaps closed as
  rule-table data**, each proven by a real card compiling `'complete'` with pinned params AND playing
  correctly in an engine game (`packages/cards/src/compile/template-gaps.test.ts`). Closed:
  **anthem statics** ("[Other] creatures you control get +X/+Y / have KEYWORD" — Glorious Anthem,
  Fervor; new `ClauseContribution.statics` reaches the `statics.ts` layer that existed with no rule
  able to emit it), **basic-land search** ("…for a basic land card, put it/that card onto the
  battlefield [tapped]" — Rampant Growth, and it **UN-STUBS Sakura-Tribe Elder**, now removed from
  `STUBBED_MECHANICS` with its full activated ability authored in the pool), **typed regrowth**
  (Raise Dead), **targeted discard** (Mind Rot — victim chooses), **targeted draw/lose** (Sign in
  Blood; `drawCards` gained `whichPlayer:'targetPlayer'` — param extension, NO new primitive, so
  paired-arms-config is untouched), and **Act of Treason's exact templating** ("Untap that
  creature."). The Treason play test caught a REAL engine bug: a control change from a resolving
  SPELL silently no-oped (`applyControlChange` derives the stealer from the source's battlefield
  presence; a sorcery is never there) — fixed with a fallback `stealer` param passed from the
  resolution's controller, core regression test added. Every existing "gain control" import was
  affected. Deliberately NOT built (need real systems; sibling branches own several): Tarmogoyf
  (characteristic-defining P/T; `StaticAbility` deltas are fixed numbers), Fatal Push (no turn-scoped
  event memory for revolt), scry/surveil (no bottom-of-library primitive), colored statics
  (`CardFilter` has no color field), modal "choose three / one or both", {X}/kicker/cycling,
  transform, planeswalkers. Coverage audit re-run: **178 → 190 playable (8.5% → 9.0%)**. About page
  gains witness-pinned entries (anthems, ramp/sac-fetch). `npm run verify` exit 0, full suite green,
  `npm run build` exit 0. (Worker)
- 2026-08-17 worker: `feat/nonhand-casting` 🚧 PUSHED — **casting from a non-hand zone + flashback,
  played as printed.** `CastSpellAction.fromZone` ('hand' default | 'graveyard') makes the source zone
  explicit cast → stack → resolution: `applyCastSpell` validates against the LIVE zone (a card that
  left the graveyard mid-response cleanly rejects) and pays `CardDefinition.flashback` instead of the
  printed cost; the stack object records `castFrom`; and BOTH exits from the stack derive their
  destination from that one field via core's new `spellLeaveDestination` — resolution → EXILE, and a
  **countered flashback spell → EXILE too** (CR 702.34a; `counterSpellOnStack` uses the same helper, so
  the two exits cannot disagree). Timing is the card's own (sorcery flashback only at sorcery speed —
  tested both as not-offered and as rejected). ⚠️ `cloneStackObject` copies field-by-field: `castFrom`
  is added there conditionally (ordinary spells keep their object shape) and PINNED by a test — drop it
  and a cloned flashback cast silently resolves to the graveyard. `generateLegalActions` offers
  flashback casts exactly as hand casts (timing + pool-funds-it + one offer per legal target).
  **Pilots actually consider it**: the heuristic's `scoredSpellGoals` scores graveyard flashback
  candidates through the same scorer/targeter as hand spells (goal carries `fromZone`; both
  `pursueSpell` and the search-policy macro emit it), and `flashback-pilot.test.ts` proves the pilot
  taps toward and submits a flashback cast the engine accepts. Compiler: new STATIC rule
  `flashback-cost` ("Flashback {2}{U}", instants/sorceries only, PLAIN mana only) + the Scryfall
  keyword sweep skips a compiled Flashback; hint reworded to a template gap. **Deliberately NOT done**:
  {X}/additional-cost flashback ("Flashback—{1}{U}, Pay 3 life") stays `incomplete` — blocked on the
  cast-cost-modification system a sibling is building; Snapcaster Mage stays STUBBED (reworded: the
  GRANT needs targeting a graveyard card + a continuous effect on a non-battlefield card — neither
  exists); no flashback card added to the curated pool (none is in the committed Scryfall index, and
  the expansion pipeline is a full network re-fetch — importer path only for now); no graveyard-cast
  affordance in the play UIs (hand-click only; the actions ARE in `legalActions`, follow-up for
  whoever owns the boards); UNSUPPORTED-BACKLOG.md not regenerated (network corpus). Also fixed stale
  claims: `FIDELITY_CAVEAT` + cli/swap/uw-control/pool.ts/UNSUPPORTED-MECHANICS no longer say
  "flash/flashback unimplemented" (flash + printed flashback are real; only the GRANT isn't). 👉 NOTE
  for the integrator: Snapcaster's pool entry could carry `flash` now, but that speeds up UW Control
  and moves every recorded gauntlet baseline — left as a deliberate integrator call. Verified:
  full suite **2456 passed, 0 failed** (baseline 2424 + 15 new + suite drift), `npm run verify` exit
  0, `npm run build` exit 0; gauntlet seed 99 **79/280 = 28.2%, byte-identical to main's recorded
  baseline** (no flashback card exists in the gauntlet, so identical is the right answer; the new
  legal-action loop is one property read per graveyard card with an early-out). (Worker)
- 2026-08-18 worker: `feat/double-faced-cards` 🚧 PUSHED — **the second card face + transform,
  and Delver of Secrets is UN-STUBBED (both faces play as printed).** The seam is one swap, not a
  parallel read path: a front `CardDefinition` nests its full back face (`backFace`, `isBackFace`,
  id `<frontId>#back`), and **`CardInstance.def` IS the active face** (`printedDef` holds the front
  to revert to, keeping definitions acyclic/serializable). Every characteristic read — combat,
  targeting, triggers, statics, mana, AI evaluation, board/CardHover art — already goes through
  `inst.def`, so the swap routes them all with no second code path. `transformPermanent`
  (core `transform.ts`) is the ONLY writer; new `transformed` event; CR 712 pinned by tests
  (counters/damage/auras/tapped/continuous persist; NO zoneChange; leave-the-battlefield reverts to
  front in `resetInstanceForNewZone` — a bounced Aberration is a Delver in hand); back faces refused
  by cast/play (CR 712.8b) and offered nowhere.
  ⚠️ **Two traps found and fixed — read these before touching faces.** (1) `cloneInstance` copies
  field by field: `printedDef` is copied conditionally (like `attachedTo`) or a transformed permanent
  silently untransforms at the NEXT action boundary — pinned by a two-boundary test. (2) The trigger
  collector cached sources per instance keyed on controller only ("abilities are immutable") — false
  once `def` can swap mid-action. It now compares the trigger-list IDENTITY and *deletes* the entry
  when the active face is triggerless (a transformed-away face must not keep firing as
  last-known-info — that rule is for permanents that LEFT). Both directions tested in one action:
  transform-then-die fires the back face's dies-trigger, never the front's.
  ⚠️ **`movePermanentTo` in `packages/cards/src/effect-helpers.ts` is a SECOND copy of core's
  leave-the-battlefield reset** (bounce/exile primitives use it, core paths use
  `resetInstanceForNewZone`). It now does the face revert too, but it is a duplication that will bite
  the next per-object field — worth unifying when someone owns both packages.
  👉 Compiler: a `layout:'transform'` / `Transform`-keyword record compiles BOTH faces through the
  full rule table and links them; complete ONLY if both faces are. Detection works without `layout`
  because the committed index predates it (keyword fallback). Scryfall's card-level keyword list is
  the UNION of both faces (Delver says Flying; only the back has it) — attributed by face text, never
  guessed. Delver's upkeep body is ONE primitive `transformRevealTop` (look + may-reveal + transform):
  a min-0/max-1 top-of-library selection whose valence follows the top card ('gain' if it matches, so
  the pilot reveals exactly when it should) with a CONSTANT public prompt — `choiceAsked` carries only
  a count, so a declined reveal leaks nothing (pinned by a test comparing both worlds' logs).
  Classified library-reading in `paired-arms-config` (it looks and branches, same as `revealTopCard`).
  ❌ **Deliberately NOT done, and why:** modal DFCs / split / adventure (second face is CASTABLE —
  needs the cast-time face/cost choice a sibling branch owns; they report the named
  `SECOND_CASTABLE_FACE_GAP`); werewolves/daybound (needs a day-night tracker — their lines still
  report); generic "transform ~" from activated/other templates (no rule yet — hint reworded to a
  TEMPLATE gap since the system now exists); copy/clone of a transformed permanent (engine has no copy
  effects); no `cardsRevealed` event (same pre-existing gap as `revealTopCard` — mechanics exact, the
  reveal itself absent from the log); UNSUPPORTED-BACKLOG.md not regenerated (coverage-audit needs a
  live Scryfall fetch). Expanded pool untouched — Delver lives in the curated pool.
  Verified: full suite **2469 passed / 0 failed**, `npm run verify` exit 0, `npm run build` exit 0
  (origin/main had not moved at push time — no merge was needed). (Worker)

- 2026-08-17 worker: `feat/shocklands` 🚧 PUSHED — **shocklands play as printed, on BOTH entry
  paths.** New `payLife` choice kind (engine charges the life once in `applyAnswerChoice`, CR 118.4
  re-checked against the live total; pay-to-exactly-zero legal and lethal). The price is a decision,
  not a board fact: `CardDefinition.entersTappedUnlessLifePaid`, with `entersTapped` answering TRUE
  so any path that cannot ask yields the unpaid default (tapped) — never a free untapped shockland.
  Asked at `applyPlayLand` (tapped event deferred until a decline confirms it; player keeps
  priority) and mid-resolution via `ctx.payLifeOrDecline` in `searchLibrary → battlefield` (the
  fetch path; ask-first, `putOntoBattlefield` gains `ignoreEntersTapped` for the paid entry). A
  player who cannot pay is never asked. Pilot pays while remaining life stays above
  `desperateLifeThreshold`. Also fixed rule 305.6: two basic land types now compile to
  `producesOptions` (a choice of one mana per tap), not a two-mana bundle. Curly apostrophes fold to
  straight in `normalizeClause`. Reworded the stale `enters tapped` UNSUPPORTED_HINT and the stale
  `activated.test.ts` shockland-is-unsupported test. Coverage audit re-run: **155 → 178 playable
  (7.4% → 8.5%)** — the whole shock cycle (Watery Grave, Blood Crypt, Steam Vents…) off the backlog.
  NOT done: no new effect primitive (nothing for paired-arms-config), no shockland added to the
  curated pool (importer path only), no reanimation/token entry paths (none exist yet — they inherit
  the tapped default by construction). `npm run verify` exit 0, full suite green, `npm run build`
  exit 0. (Worker)
- 2026-08-17 worker (feat/about-mechanics): **About view shipped — a LIVE supported-vs-TODO
  mechanics page**, pushed, not merged. New nav tab "About" renders entirely from the compiler's
  own registries (`EFFECT_RULES`/`TRIGGER_RULES`/`STATIC_RULES`/`MANA_RULES`, `KEYWORD_FLAGS`,
  `UNSUPPORTED_HINTS`, `TYPES_WITHOUT_SYSTEM`, `STUBBED_MECHANICS`, `CARD_POOL`, primitive maps) —
  no prose copy to go stale. The one hand-written piece (readable "supported" group blurbs) is
  pinned by WITNESSES (rule id / primitive / keyword / pool card / oracle text that must compile
  `'complete'`), and `apps/web/src/lib/about/mechanics.test.ts` resolves every witness on every
  test run, so a removed mechanic fails the suite instead of lying on the page. Also surfaces the
  per-browser "gaps you've hit" queue from `unsupportedRegistry` (live subscription + Markdown
  export). `packages/cards` edits are re-exports only — no behavior change. Verified: full suite
  **2349 passed, 0 failed** (re-run after merging origin/main incl. fix/online-playability:
  **2424 passed, 0 failed**); `npm run verify` exit 0; `npm run build` exit 0; live dev-server check
  of the About tab on :5199 — renders real derived data (62 templates, 14 keywords, 9 missing
  systems, 22 template gaps, 7 stubbed cards), 0 console errors. NOT done: no DESIGN §3 flip (the
  About page is not a §3 roadmap row); no debug-inspector entry (the page is itself the inspector
  for compiler coverage — say if you want one anyway).

- 2026-08-15 DESKTOP-90PJPM4: ✅ **RESOLVED — the "unplayable online" report, diagnosed and fixed.**
  Branch `fix/online-playability` (worktree `D:\Cool Stuff\Claude\jb-online`). Suite **2273 passed,
  0 failed** (was 2250); `npm run build -w @jonny-boi/web` exit 0; lint clean. The handoff brief
  below is now HISTORY — read this entry first.

  **ROOT CAUSE (not a bug in the server, the masking, or the adapter — all were sound, as the brief
  had already proven).** A game opens in the `upkeep` step, and BOTH seats are given priority in
  `upkeep` and again in `draw`, where the server's only legal action is `passPriority`. So the board
  said **"Your move"** over a hand in which every card — the Mountain included — was
  `play-card--disabled`, and the first land could not be played until **four `Pass / advance` clicks**
  (two per seat) had gone by. Reproduced exactly, on both seats, before changing anything: that is
  the user's "I can't even drag lands out… clicking, dragging, nothing works."

  - **LEAD 2 split: UX defect, not an adapter bug.** The waiting seat DID render "Waiting for Alice…"
    correctly, so `board-adapter.ts` is exonerated. The dead-hand-on-your-own-turn half is the real
    fault.
  - **LEAD 1 confirmed and still open.** There is no drag-and-drop anywhere in the online board; hand
    cards are click-only. Dragging never worked and still doesn't — a missing feature, not a regression.
  - **LEAD 3 looks unreachable.** `screen: 'mulligan'` is only ever set by `mulliganPrompt`, which
    always carries a hand, so the `OnlinePlay.tsx:137` "Waiting for your hand…" dead end appears to be
    dead code. NOT proven; left alone.

  **THE FIX** (all in `apps/web`, disjoint from other branches):
  - `lib/online/auto-pass.ts` (new, pure) — advance automatically when passing is the ONLY thing the
    seat may do. Narrow by construction: it stops on any non-pass legal action, a non-empty stack, a
    parked choice, or a card fundable by tapping — so it cannot skip a decision. Verified live that
    `declareBlockers` stops it, so blocks are never auto-skipped.
  - `lib/online/why-disabled.ts` (new, pure) — every greyed card now says WHY on hover
    ("Lands can only be played in your main phase", "You've already played a land this turn",
    "Waiting for Alice — you don't have priority yet").
  - `AUTO_PASS_EMPTY_PRIORITY` / `AUTO_PASS_DELAY_MS` in `online-config.ts`; `PlayCard` gained an
    optional `reason` tooltip (additive — hotseat unchanged).

  **TWO TRAPS worth knowing, both found only by running it:**
  1. **StrictMode kills a naive auto-advance.** Marking the window as "passed" at *schedule* time
     deadlocks: run 1 marks + schedules, the cleanup cancels the timer, run 2 sees the mark and
     declines to reschedule → the board sits on "advancing…" forever. Mark it when the pass FIRES.
  2. **Do not dedupe on a `turn:step:priority` key.** A seat legitimately needs to pass TWICE in one
     `declareBlockers` step with the stack empty throughout (priority returns after blocks are
     declared). That key calls the second window a duplicate and hangs the game — observed. Dedupe on
     the identity of the frame the server pushed instead.

  **UPDATE 2026-08-17 — LEAD 1 CLOSED: drag-to-play shipped** (same branch, suite now **2284/0**,
  build exit 0). Built on **Pointer Events, not HTML5 drag-and-drop**, deliberately: `dragstart`/
  `drop` never fire on touch browsers and this PWA ships to Android — half the audience would get a
  silently dead drag, the exact "looks broken" class this branch exists to kill. Pure state machine
  in `lib/online/drag-to-play.ts` (11 tests: threshold, drop-in/out, no un-commit, idle edges), DOM
  glue in `useDragToPlay.ts`, wired so drag and click route through ONE `activateHandCard` — a drag
  can never diverge from what clicking the same card does. The viewer's seat panel is the drop zone
  (dashed outline while a card is in flight, solid+tint when over). Verified live both ways: Alice
  dragged a Mountain onto her battlefield; Bob played a Guildgate by plain click through the same
  path; a release outside the zone cancels and plays nothing.

  Three integration notes: (1) the press-vs-drag threshold (`DRAG_START_THRESHOLD_PX`) is what keeps
  tap-to-play alive on touch — every tap wobbles a few px and would otherwise die as a zero-distance
  drop; (2) after a real drag the browser still synthesizes a `click` on the pressed card —
  `onClickCapture` swallows exactly that one, or a drop would submit twice; (3) `setPointerCapture`
  throws on pointers the browser no longer considers active — it is wrapped as the enhancement it
  is, never a gesture-killer.

  **STILL OPEN (not mine, not done):** the lobby defaults the deck picker to the user's *invalid*
  imported deck ("deck size 2 is below the minimum of 60") so a new player's first sight is a wall
  of red errors and a disabled button; the web app has **no debug inspector panel at all**, so rule 3
  has no seam to register against; and online play has no DESIGN.md §3 entry to flip. Hotseat could
  lift the same drag hook later — the machine has no online dependency; it lives in lib/online only
  to respect this branch's file claim. (Integrator)

- 2026-08-15 DESKTOP-90PJPM4: 🔴 **HANDOFF — ONLINE MULTIPLAYER IS UNPLAYABLE.** *(superseded by the
  entry above — kept for the elimination trail.)* User report,
  verbatim: "I joined with someone but I cant even drag lands out to play them. Tried clicking,
  dragging, nothing works." NOT FIXED. Branch `fix/online-playability` carries only the
  investigation. **Read this before touching online play so you do not redo the elimination.**

  **ALREADY RULED OUT — do not re-investigate.** `apps/server/src/land-playability.test.ts` drives
  a real two-player game through the transport-free `Room` with fake connections and asserts, FOR
  BOTH SEATS: priority is held in its own precombat main, ≥1 `playLand` is offered, every offered
  `instanceId` is in that seat's own MASKED hand, and submitting it puts the land on the
  battlefield. All 6 pass (suite 2250, 0 failed). So the server, the masking, the legal-action
  path and the id alignment are SOUND. The fault is above them: client rendering, input wiring, or
  the user simply not holding priority.

  **LEAD 1 — there is no drag-and-drop at all.** `apps/web/src/components/online/OnlineBoard.tsx`
  wires only `onClick`: no `draggable`, no `onDragStart`/`onDrop`, no drop targets anywhere.
  Dragging a land can never have worked. This is a MISSING FEATURE, not a regression — so half the
  report is explained outright, and "clicking does nothing" is the part still unaccounted for.

  **LEAD 2 (most likely for the click half) — a waiting seat is indistinguishable from a broken
  app.** The seat without priority is sent `legalActions: []`, so every card greys out. Pinned
  deliberately as the last test in that file, because it is correct behaviour that LOOKS like the
  bug. The user JOINED someone else's game, i.e. was seat B on seat A's turn. Check what the action
  bar actually rendered: if it said "Waiting for <name>…" the app was working and this is a UX
  defect (make the waiting state loud, and say WHY the hand is dead). If it said "Your move" and
  clicking still did nothing, the fault is in `apps/web/src/lib/online/board-adapter.ts`
  (`maskedViewToBoardView`, line ~126: `self: seatView(view.players[viewer], …)`) or in
  OnlineBoard's disabled predicate — everything beneath those is already proven good.

  **LEAD 3 — a real dead end, unproven as this bug.** `apps/web/src/components/online/OnlinePlay.tsx`
  ~line 137: when phase is `mulligan` but `mulliganHand` is missing, it renders a bare "Waiting for
  your hand…" with NO Keep button and no recovery. A player who lands there is stuck forever.

  **START HERE:** run the app, open two browsers, join a room, and screenshot BOTH seats' action
  bars on turn 1. That single observation splits LEAD 2 into "UX defect" vs "adapter bug" and costs
  minutes. Do not start by reading the server.

  ⚠️ FIXTURE TRAP that cost a cycle, now commented in the test: `DeckList.cardId` is the card
  **NAME** (`'Forest'`, not `'forest'`). A wrong id is SILENTLY an unknown card → deck rejected →
  the room never starts a game → every assertion fails with "never sent a state", pointing nowhere
  near the deck. Worth checking whether the real deck-selection screen fails as silently.
  (Integrator — handing off with ~0 context left.)

- 2026-08-15 integrator: **`feat/blocking-restrictions` + `feat/derived-values` MERGED + DEPLOYED**
  (both Deploy PWA green). main = **2244 tests, build exit 0**.
  - **Menace / can't-be-blocked.** Menace is NOT a keyword flag — it constrains the block
    DECLARATION, not any pair: each blocker individually *can* block a menacing creature, and the
    rule forbids exactly one doing it. `canBlock` is per-pair and structurally cannot see that, so a
    flag-only version silently does nothing. New `illegalBlockDeclaration` judges the assignment as
    a whole. Zero blockers stays legal.
  - **Derived values** are implemented at `intParam`, the chokepoint every numeric param already
    reads — so damage, draw, life, mill and pump ALL got "equal to the number of…" with no
    primitive touched, and future primitives inherit it. Closed vocabulary on purpose.

  ⛔ **THE REMAINING SEVEN ARE EACH BLOCKED ON A NAMED, MISSING SUBSYSTEM.** They are not more
  rule-table work, and I stopped rather than half-build them. In dependency order:
  1. **Choice outside a resolution frame.** `pendingChoice` can only be parked by a resolution
     frame, so anything asking a question at another moment is blocked. This gates **targets chosen
     by a triggered ability** (targets are chosen when it goes ON THE STACK) and **shocklands**
     ("pay 2 life" at land-play). ⚠️ Do NOT "fix" trigger targets by auto-picking when exactly one
     legal target exists — the compiler would report COMPLETE and the card would then fizzle
     whenever the board has two, which is worse than reporting it.
  2. **Source-aware targeting.** `isLegalTarget` knows the CASTER, not the source card, so
     **protection from a color** cannot be checked (protection is about the source's colour). The
     blocking and damage halves are reachable today; shipping only those would be a card that obeys
     a third of its text.
  3. **Cost modification at cast time** — gates **{X}, kicker, suspend, spectacle**.
  4. **Casting from a non-hand zone** — gates **flashback**.
  5. **A second card face** — gates **transform/DFC**.
  6. **Loyalty counters + planeswalkers as an attackable object with damage redirection** — gates
     **planeswalker loyalty**, the largest of the set.
  **optional payment during resolution** ("unless its controller pays") is the one genuinely
  reachable next: it happens INSIDE a resolution frame, where `ctx.ask` already works. Whoever
  takes it needs a mana-payment answer kind, not a new choice mechanism.
  (Integrator)
- 2026-08-15 worker: `fix/land-sequencing` 🚧 PUSHED — **`feat/tactical-eval`'s `DEFECT (unfixed)` is
  fixed: the default pilot now plays the land its own spell needs. It moves every recorded heuristic
  baseline in this repo, on purpose, and all of them are re-measured below.** `packages/ai` only, plus
  DESIGN §3.4e and baseline notes in §3.4a/§3.4b/§3.4d. Branches off `main`. `npm run verify` exit 0 —
  **2246 passed / 0 failed** (main baseline 2226 + 20 new), lint 0 errors, `npm run build` exit 0.
  ❗ **HEADLINE: the fixed pilot beats the pilot it replaces 51.7% of discordant games
  [50.5, 52.8] over 80,000 PAIRED games — real, and small (+0.33 win-rate points).** The interval
  excludes 50%. It took 80,000 games to say that, and the reason is in the next bullet.
  ⚠️ **PAIRED (McNemar) IS THE ONLY INSTRUMENT THAT CAN SEE THIS, and unpaired win rates at the sample
  sizes on record here cannot.** Two pilots that differ on a few percent of land drops agree on the vast
  majority of games; only the DISCORDANT games carry information. Unpaired, the same change is
  50.3% vs 50.3% — indistinguishable. **At n=120 (the size of every hybrid baseline in DESIGN) an effect
  this size is invisible**, so do not try to detect a similar one that way.
  · Boros vs Orzhov, n=40,000: **50.9%** [48.6, 53.1] of 1,856 discordant (4.6% of games), +0.08 pts
  · UW Control vs Golgari, n=40,000: **52.0%** [50.6, 53.3] of 5,071 discordant (12.7%), +0.50 pts
  ⛔ **I ALMOST SHIPPED A DEFAULT CHOSEN BY THE GARDEN OF FORKING PATHS, AT n=40,000. READ THIS ONE.**
  The per-term ablation on Boros vs Orzhov said the unlock term ALONE beat the three-term blend — 52.6%
  [50.2, 55.1] (excludes 50%) against the blend's 50.9% [48.6, 53.1] (does not). That is a clean,
  well-powered case for zeroing the other two terms, and I wrote it into the defaults. Re-running the
  identical comparison on UW vs Golgari **reversed it exactly**: blend 52.0% [50.6, 53.3], unlock alone
  50.9% [49.4, 52.5]. n=40,000 is large enough to feel authoritative and not large enough to be, when the
  thing you are choosing is the best of four arms. **All three terms ship on**; the near-miss is recorded
  in `weights.ts` next to the numbers so the next person does not re-derive the wrong half of it.
  ❗ **EVERY RECORDED NUMBER THIS INVALIDATED, RE-MEASURED — DO NOT QUOTE THE OLD ONES.**
  · Gauntlet `Mono-Red Aggro` 40 games/deck seed 99: **92/280 = 32.9% → 79/280 = 28.2%**
  · `hybrid` vs `heuristic`, Mono-Red vs Boros, n=120: **60.0%** [51.1, 68.3] → **55.8%** [46.9, 64.4]
  · `hybrid` vs `heuristic`, UW Control vs Golgari, n=80: **53.8%** [42.9, 64.3] → **48.8%** [38.1, 59.5]
  · Curated suite: heuristic **10/12 → 11/12**, both hybrid arms **11/12 → 12/12**
  ⚠️ **MONO-RED'S GAUNTLET WIN RATE FELL AND THAT IS THE FIX WORKING, NOT A REGRESSION.** Mono-Red Aggro
  is 24 Mountains — its own play is byte-identical — and six of its seven opponents are two-colour decks
  that got better at sequencing. Its one mono-coloured opponent (Mono-Green Ramp) is **8/40 in every run
  before and after**. Same story for the hybrid: the heuristic is both the baseline it is measured
  against AND its own prior/rollout policy, so both sides improved and the gap narrowed. **`hybrid.ts`
  and `DEFAULT_HYBRID_CONFIG` are untouched.** The honest consequence is that the hybrid's headline
  "significantly stronger on fast tactical boards" **no longer holds at n=120** — its interval now
  includes 50% on both matchups.
  👉 **THE CONTROL ARM IS THIS BUILD, WHICH IS WHY THE A/B IS TRUSTWORTHY.**
  `LAND_SEQUENCING_OFF_WEIGHTS` zeroes the three new weights; every land then ties and a tie resolves to
  the first offered action — the pre-fix pilot exactly. **Verified, not asserted:** a sha256 over every
  action both seats chose, three matchups, **48,064 plies**, is **identical to the same games played by a
  separate checkout of `main`**. So both arms run in ONE process on interleaved games.
  👉 **PROVABLY CONFINED TO DECKS HOLDING MORE THAN ONE LAND TYPE.** Mono-Red vs Mono-Green produces the
  **identical digest** with the fix on and off (`40f2a1b619c0f171`, 10,621 plies).
  ⛔ **A METHODOLOGICAL BUG IN HOW WE HAVE ALL BEEN READING `headToHead`, and it is worth 3 points.**
  `winRate` is wins / **games**, so a timeout draw counts against **both** sides. An arm byte-identical to
  its baseline scores **46.4%–49.8%**, not 50%, on any matchup that draws — I spent a measurement round
  reading that as "my change is 3 points worse". The bench now ships a `none` self-versus-self arm and a
  decisive-games-only restatement. **Every `hybrid`-vs-`heuristic` number on record here is depressed by
  the same amount**; they are comparable with each other and are NOT comparable with 50%.
  👉 **PER-TERM ABLATION — one term carries the effect and the other two do not** (Boros vs Orzhov,
  n=8000 paired, share of discordant games): `+unlock` **55.4%** [49.9, 60.6] · `+color` **54.9%**
  [48.4, 61.2] · `+tapland` **50.5%** [41.3, 59.6] · all three **52.8%** [47.7, 57.8]. The colour term has
  little to do on this pool (8+8 basics plus four Guildgates is already well fixed) and the tapland term
  fires on 1.4% of games. Both are kept as correct play that costs nothing, not because they measured.
  👉 **THE TAPLAND RULE IS THE INVERSE OF THE ONE I FIRST SHIPPED, and the ablation is why.** The first
  draft preferred the land that arrives UNTAPPED and measured **49.3%** [44.5, 54.1] — nothing. That is
  wrong twice over: the unlock term already covers the only reason to want untapped mana *today*, and
  holding a tapland does not avoid its cost, it defers it onto a turn you do not get to choose. So the
  term now says **spend the tapland on a turn where no land drop unlocks anything anyway**.
  ⚠️ **RULE 7 — the first implementation WAS a real regression (0.80×) and the fix is a filter, not a
  cache.** `planManaPayment` once per spell in hand per candidate land put the engine's hottest function
  on the pilot's hot path. Every spell now passes a NECESSARY payability condition first (`couldPay`:
  the total fits and no colour is asked for more times than the board could ever make it), which can only
  remove planner calls whose answer was already known. Final: **11 interleaved rounds × 800 games**, quiet
  box — games/sec **1.027× / 0.895× / 0.998×** (median 0.998×), µs/decision **1.026× / 0.926× / 1.030×**
  (median 1.026×). The one column under parity is the matchup where the fixed pilot also plays 3.3% LONGER
  games, so part of it is more game rather than slower code. ⚠️ Single-round
  runs of the *identical* builds read **0.76×–0.88×** while other work shared the box. A one-round
  "interleaved" run is a sequential run wearing a hat.
  👉 **NEW SEAMS in `packages/ai`, all additive:** `rankLandDrops` / `bestLandDrop` / `describeLandDrop`
  over a `LandDropOption`, plus `LAND_SEQUENCING_OFF_WEIGHTS`. `totalAvailableMana` MOVED from
  `heuristic.ts` into `land-sequencing.ts` and is imported back (both need it; that module is the leaf, so
  the alternative was two copies of a bound that must agree). New bench mode `land-sequencing <n>` with
  `BENCH_LANDSEQ_ARMS=none,full,unlock,color,tapland`; `headToHead` gained an optional baseline factory
  and per-game outcomes so arms can be compared **pairwise**.
  ⚠️ **I touched ONE existing test beyond the flip.** `tactical-suite.test.ts`'s "no pilot sweeps it" now
  says "at least one pilot still has headroom": both search arms now solve 12/12 because the puzzle they
  used to miss was the one this branch fixed, so the old form would be a test demanding the defect come
  back. The heuristic still misses the anti-lethal crackback, and the evaluator half is still 0/5.
  ❌ **SECONDARY TASK ANSWERED, AND THE ANSWER CLOSES THE QUESTION: the tactical evaluator does NOT earn
  its place at a low budget either.** §3.4d's hypothesis on record was that at 160 simulations the search
  simply plays these positions out to a terminal, so a better leaf evaluator has nothing to add — and
  that a THRIFTY budget would give it room. Measured at 64 and at 32 simulations, interleaved arms on
  paired seeds, control = `DEFAULT_HYBRID_CONFIG` at the same budget:
  · 64 sims, Mono-Red vs Boros n=120: control **53.3%** [44.4, 62.0] · tactical **47.5%** [38.8, 56.4]
  · 64 sims, UW vs Golgari n=80: control **48.8%** [38.1, 59.5] · tactical **46.3%** [35.7, 57.1]
  · 32 sims, Mono-Red vs Boros n=120: control **48.3%** [39.6, 57.2] · tactical **45.0%** [36.4, 53.9]
  · 32 sims, UW vs Golgari n=80: control **48.8%** [38.1, 59.5] · tactical **45.0%** [34.6, 55.9]
  Pooled: control **200/400 = 50.0%**, tactical **184/400 = 46.0%**. The tactical arm is **behind in all
  four cells** — not significantly in any one of them, but never ahead, which is the opposite of what the
  hypothesis predicted. Cost is identical to two decimal places (1.71 vs 1.74 ms, 1.14 vs 1.14 ms), so
  this is not a throughput trade either. `TACTICAL_HYBRID_CONFIG` and `TACTICAL_EVALUATION_WEIGHTS` stay
  **off**, and "try it at a smaller budget" is now a closed line rather than an open one. §3.4d's other
  suggestion — re-ask when the SEARCH changes, or when a learned value function needs these terms — is
  untouched by this.
  Re-runnable: `BENCH_CONFIG='{"budget":{"kind":"simulations","simulations":64}}'
  BENCH_TACTICAL_ARMS=control,full node packages/ai/bench/mcts-bench.mjs tactical 120`.
  ⛔ **NEEDS AN OWNER ELSEWHERE — reported, not done (I own only `packages/ai`):**
  · **Three comments in `apps/web` now quote a dead number**: `lib/sim/history-store.ts:33`,
    `lib/sim/pilots.ts:13` and `lib/sim-protocol.ts:44` all cite the heuristic gauntlet at **32.9%** (now
    28.2%) to illustrate "deck verdicts are pilot-relative". The *point* they make is still true; the
    figure is not. Also `lib/sim/pilots.ts:106` sells the Hybrid pilot to the user as "Beats the heuristic
    60.0% head-to-head (95% CI 51.1–68.3)… 53.8%" — that is now **55.8% [46.9, 64.4]** and **48.8%
    [38.1, 59.5]**, i.e. **user-facing copy that overstates the pilot**. This is the one worth fixing
    soon.
  · **`19.0%` (the hybrid-both-seats gauntlet figure) is also stale** and I did not re-measure it — a full
    gauntlet under `--pilot hybrid` is an hours-long run. It is quoted in DESIGN §3.4a, COORDINATION and
    the same three `apps/web` comments.
  · The `cardValue` ruler used to price an unlocked spell is the CARD-RANKING ruler (a big creature
    outranks a removal spell), not the pilot's own PLAY ranking (removal outranks a creature). It only
    matters when two lands unlock two different spells, which is rare, and giving `land-sequencing.ts` a
    second scoring vocabulary is exactly the drift this repo has been bitten by. Left as is, flagged.
  (Worker — pushed, NOT merged.)

- 2026-08-15 integrator: **`feat/trigger-targets` MERGED + DEPLOYED** — **targets chosen by a
  triggered ability**, i.e. the first question this engine asks with NOTHING RESOLVING. `npm run
  verify` exit 0 — **2316 passed / 0 failed** (main baseline 2295 + 21), `npm run build` exit 0.
  ❗ **THE WAITING LIVES ON THE STACK OBJECT, NOT BESIDE IT.** `TriggeredStackObject.awaitingTargets`
  holds what may be chosen and is cleared the instant the aim is recorded, so "is anything still
  waiting to be aimed?" is answered by the stack itself — a separate pending-targeting record would be
  a second source of truth that could drift, which is the same argument that keeps state-based actions
  derived from the board. `aimPendingTriggers` runs right where the rules say targets are chosen: at
  the flush, before anybody holds priority.
  ⚠️ **`cloneStackObject` COPIES FIELD BY FIELD, AND `applyAction` CLONES AT EVERY BOUNDARY.** A new
  stack-object field that is not added there is silently dropped on the very next action — here that
  would have meant the trigger resolving at nothing, with no error anywhere. Pinned by a test that
  clones a parked aim and asserts the marker survives. **Anyone adding a stack-object field must edit
  `internal/clone.ts`.**
  👉 **`TriggeredAbility.targets` declares what the ability aims at — deliberately on the ABILITY, not
  inferred from its primitives.** The same `dealDamage` ref is targeted in "deals 2 damage to target
  creature" and untargeted in "deals 2 damage to each creature", so inferring would be guessing. It
  also keeps SPELL targeting untouched: `targetRestrictionOf` still ignores the default "any target"
  for casts, so `generateLegalActions` does not start enumerating one cast per creature (the perf
  reason that rule exists).
  ⚠️ **ONE LEGAL TARGET IS TAKEN; TWO IS ALWAYS ASKED.** The brief's explicit trap was auto-picking
  when exactly one legal target exists *as a way to make a card compile*. What ships is the rules
  reading: one lawful aim is not a decision (`isTrivialChoice` settles it, as it already did for every
  other kind), and **two or more is a real decision that always stops the game**. Zero removes the
  ability from the stack unresolved (CR 603.3d) with its own event — a trigger that vanished silently
  is indistinguishable from one that never fired.
  👉 **THE PILOT AIMS BY PRICING THE ABILITY'S OWN EFFECTS, WHICH IS THE ONLY THING THAT CAN WORK.**
  A target choice carries no valence that could say whether being pointed at is good: "which
  creature?" wants the opponent's for damage and its own for a pump. So each candidate is scored with
  `valueOfEffects` (the same scorer that picks a modal spell's modes) against the ability found on the
  stack by its `awaitingTargets` marker.
  ⛔ **THAT SURFACED A REAL DEFECT IN THE SHIPPED SCORER, AND I FIXED IT: `pumpUntilEndOfTurn` was
  priced as a FLAT CONSTANT regardless of target.** Every candidate therefore tied and the first
  offered won — "target creature gets +2/+2" would have buffed the opponent's blocker. It now prices
  by whose creature it is, and reads a NEGATIVE pump as the shrink-removal the pool writes with it
  (Disfigure), which wants the other side of the table. New weight `modePumpPerStatValue`.
  ⚠️ **RULE 7 + BEHAVIOUR, MEASURED AGAINST MAIN ON THIS BOX.** `npm run sim -- gauntlet "Mono-Red
  Aggro" --games 40 --seed 99`: **79/280 = 28.2% on this branch and 79/280 on main**, byte-identical,
  at 240–245 games/sec against main's 242. Nothing in the gauntlet declares a targeted trigger yet, so
  identical is the right answer — and I checked the pump-valuer change separately (stashed, re-run,
  same 79/280) rather than assuming.
  ⚠️ **HEADS-UP ON THE RECORDED BASELINE: main is 79/280 now, not the 92/280 written in older notes.**
  `fix/land-sequencing` moved it, exactly as its author warned. I re-measured main directly rather
  than treating the difference as my own regression; anyone comparing against an old number should do
  the same.
  ❌ **WHAT I DID NOT DO.** (1) **Shocklands are still blocked** — they were the other half of this
  brief item, and they need the question asked as a permanent ENTERS (a replacement effect at
  land-play time), which is a different moment from "an ability went on the stack". The subsystem
  built here does not reach it; it is its own branch. (2) A trigger body needing TWO separate targets
  keeps reporting — one printed template, two aims, and quietly pointing both halves at one object
  would be a card playing differently from its text. (3) The generated expanded pool was NOT re-run,
  so no new pool card exercises this yet; the mechanic is proven by a compiled Flametongue Kavu played
  through the real engine (`packages/cards/src/trigger-targets.test.ts`). Re-running
  `build-expansion.ts` is the cheap follow-up that would admit a family of ETB-removal creatures.
  👉 **Hint reworded** (the work queue is generated from these): "targets chosen by a triggered
  ability" → **"a targeted-trigger template the compiler does not recognize yet"**. The system exists
  now; what still lands there is a body shape with no rule.
  (Integrator)

- 2026-08-15 integrator: **`feat/optional-payment` MERGED + DEPLOYED** — "counter target spell
  **unless its controller pays {3}**" (Mana Leak, Force Spike, Miscalculation) plays for real.
  `npx vitest run` **2274 passed / 0 failed** (main baseline 2244 + 30), `npm run verify` exit 0,
  `npm run build` exit 0.
  ❗ **THE PAYMENT IS MADE BY THE ENGINE, NOT BY THE EFFECT, AND THAT IS THE WHOLE DESIGN.** A
  resolving effect is re-run FROM THE TOP every time it asks a further question (`ResolutionFrame`),
  so a primitive that charged its own cost would charge it again for every later ask. The mana is
  therefore spent inside `applyAnswerChoice`, exactly once, and `ctx.payOrDecline` returning `true`
  means **already paid**, never "agreed to pay". Pinned by a test with a fixture that asks a SECOND
  question after the payment — **verified RED by sabotage** (calling the payment twice fails it).
  👉 **NEW CHOICE KIND `payMana`** (core `choices.ts`) — not a `confirm` with a cost in the prompt,
  because the engine has to know the cost to answer two questions only it can: *can this player pay?*
  and *what leaves their board?* `PayManaChoice.affordable` is filled in BY THE ENGINE (a request from
  an effect leaves it off), so an effect cannot lie about it, a UI can grey out Pay, and
  `validateChoiceAnswer` rejects "I pay" when the board cannot produce it rather than silently
  downgrading it to a decline.
  ⚠️ **A PLAYER WHO CANNOT PAY IS NEVER ASKED.** Affordability is the new exported
  `canAffordManaCost(state, player, cost)` = pool + everything still untappable, planned through the
  SAME `planManaPayment` that funds a cast — so "can you pay?" cannot disagree with "here is how".
  Unaffordable ⇒ `isTrivialChoice` ⇒ the engine settles it, so the clause never stops a game nobody
  could have paid in. That also keeps the sim's decision count unchanged on boards where it is moot.
  👉 **WHICH LANDS GET TAPPED IS DELEGATED ON PURPOSE, and it is the one judgement call here.**
  Rule 605.3 lets a player activate mana abilities to pay during resolution; the engine does that
  through the shared planner (least-flexible source first) instead of asking a second question about
  *which* Island. The decision the card PRINTS is modelled in full; the sub-decision is the planner's,
  in one place, for the AI and both clients. If someone later wants that as a real choice, the seam is
  `payManaCostFromBoard`.
  👉 **ONE DEFINITION, TWICE OVER.** (1) `pushManaTapActions` now answers "which sources can this
  player tap" for BOTH `generateLegalActions` and the payment path — a second copy would have been
  free to disagree with the engine about summoning sickness. It pushes into the caller's array, so the
  hot path allocates nothing new. (2) The compiler had **two identical private mana-symbol parsers**
  (`parseEquipCost` in `rules.ts`, `parseManaSymbols` in `compile.ts`); they are now one
  `parseManaSymbols` in `compile/text.ts`, used by all three callers.
  ⚠️ **RULE 7 — measured, interleaved, on this box.** `npm run sim -- gauntlet "Mono-Red Aggro"
  --games 40 --seed 99`: main **212 / 212 / 218 games/sec**, branch **223 / 229 / 230**, and the result
  is **byte-identical (92/280 = 32.9%)**, so behaviour is unchanged on decks with no soft counter.
  ❌ **WHAT I DELIBERATELY DID NOT DO — the mechanism is general, the TEMPLATE is one line of Oracle.**
  Only `^counter target spell unless its controller pays {N}$` compiles. Still reported, correctly:
  Rune Snag (cost derived from both graveyards — charging the flat {2} would be strictly weaker than
  printed), `{X}` taxes, a payment attached to some other effect ("destroy … unless its controller
  pays"), and paying with a sacrifice/discard instead of mana. The hint was reworded to **"an
  optional-payment template the compiler does not recognize yet"** — the system is no longer missing,
  and a stale hint would send the next agent to rebuild finished work.
  ❌ **The choice does not carry the STAKE, and the pilot therefore does not compare cost to value.**
  A `payMana` question says what it costs, not what dies if you decline, so the valence rule pays
  whenever it can afford to (declining loses the spell AND the mana already spent on it). Making that
  comparison needs the stake in the choice — and a choice must stay renderable by a UI that knows no
  rules, so it belongs to a pilot that searches, not to the valence rule that answers every card ever
  printed. Said out loud in `answerPayMana`.
  ⚠️ **TRAP FOR ANYONE VERIFYING IN THE APP: `preview_start` runs the dev server in the SESSION'S
  PRIMARY CHECKOUT, not in your worktree.** I "verified" Mana Leak and got the OLD answer — the page
  was serving `@fs/D:/Cool Stuff/Claude/jonny-boi/packages/cards/dist/...`, i.e. main's build plus
  another agent's uncommitted edits. Check `performance.getEntriesByType('resource')` for the `@fs`
  path before believing any browser check on a branch. (Also on this box: several Vite servers, ports
  5173-5178 taken, `localhost` resolving to `::1` first — the port a tool reports is not necessarily
  the server you are talking to.)
  ⚠️ **SECOND TRAP, same session: the app CACHES an imported card and its verdict in localStorage**
  (`jonny-boi:imported-cards:v1`, `jonny-boi:unsupported-mechanics:v1`). Re-adding a card after a
  compiler change re-reports the STORED verdict, so "still unsupported" in the app can be a stale
  cache rather than a stale build. Clear both keys before trusting an à-la-carte add.
  👉 **One existing test changed, and it had to.** `compile.test.ts`'s `explainUnsupported` table
  listed "counter target spell unless its controller pays {3}" as an unsupported example — that clause
  COMPILES now, so the example is a payment shape that still does not
  ("destroy target creature unless its controller pays {2}").
  (Integrator)

- 2026-08-15 worker: `feat/tactical-eval` 🚧 PUSHED — **an exact combat solver + the curated tactical
  suite the brief asks for. The evaluator half is MORE CORRECT and NOT STRONGER, so it ships OFF; the
  measurement and the suite ARE the deliverable.** `packages/ai` only, plus DESIGN §3.4d. Branches off
  `main` (which already has hybrid-search + tree-reuse). `npm run verify` exit 0 — **2226 passed / 0
  failed** after merging the newer `main` (2058 before that merge; my own contribution is **+46**), lint
  0 errors, `npm run build` exit 0.
  ❗ **HEADLINE: 5/5 versus 0/5 on correctness, 50.4% over 240 games on strength.** The tactical blend
  orders every curated position pair correctly where the shipped evaluator orders **none** of them
  correctly — and head to head over 240 paired games it is **121/240 = 50.4%**. Both statements are
  true, they are about different things, and only the second one decides a default. So
  `TACTICAL_EVALUATION_WEIGHTS` / `TACTICAL_HYBRID_CONFIG` exist, are tested, and are not the default;
  `DEFAULT_HYBRID_CONFIG` is unchanged to the byte and still reproduces **72/120** and **43/80**.
  · Mono-Red vs Boros, n=120 vs heuristic: **60.0%** [51.1, 68.3] -> **60.0%** [51.1, 68.3]; 6.83 -> 6.70–6.97 ms
  · UW Control vs Golgari, n=80 vs heuristic: **53.8%** [42.9, 64.3] -> **55.0%** [44.1, 65.4]; **14.33 -> 13.63 ms**
  · head to head, aggro n=120: **48.3%** [39.6, 57.2] · head to head, UW n=120: **52.5%** [43.6, 61.2]
  ⚠️ **Cost is NOT why it ships off — it is FREE, and slightly cheaper on the control matchup.** That is
  the opposite of `feat/tree-reuse` (which cost +35–60% per decision) and it changes what "off" means:
  this is not a throughput call, it is the brief's rule that a change which does not measurably help does
  not become the default. If a later branch finds a reason to want it, turning it on costs nothing.
  👉 **THE PER-TERM ABLATION IS WHY THE CONCLUSION IS SAFE RATHER THAN LUCKY.** `bench tactical` with
  `BENCH_TACTICAL_ARMS=control,lethal,router,facing,pressure,clock,no-router`, same 120 seeded games:
  **every single arm landed on 72/120** except `+clock` (71). So this is not one good term cancelling one
  bad one — there is no winning subset hiding inside the blend, and nobody needs to re-tune the weights
  hoping to find it.
  👉 **TWO REAL DEFECTS IN THE SHIPPED EVALUATOR, FOUND AND DOCUMENTED (still live on `main`).** The
  second one has a SIGN, which is why it is worth knowing even though the fix did not pay:
  · `lethalThreatWeight` fires on *summed untapped power ≥ their life* and **ignores blockers entirely** —
    15 power behind three 0/4 walls reads as a kill, and scores ABOVE a board with 6 unblockable damage.
  · **Attackers TAP when declared**, so the bonus is paid for the board that has not swung yet and
    withdrawn the instant it does: `evaluateState` scores **taking a proven kill (0.9047) BELOW declining
    it (0.9399)**. The evaluator actively prices attacking as *losing* the lethal bonus.
  ⚠️ **WHY §39's COMBINATORIAL TRAP DOES NOT APPLY HERE, and it is structural rather than clever.** Two
  facts collapse it: (1) **damage assignment is not a decision in this engine** (`internal/combat.ts`
  assigns lethal in declared order and tramples the rest), and (2) **block legality is NESTED** — core's
  `canBlock` refuses exactly one thing, a flier blocked by a non-flying non-reach creature. So the
  feasible attacker sets form a **matroid** and greedy by damage-prevented descending is *exactly*
  optimal with no matching algorithm at all. A test pins that legality claim against the real engine, not
  against the comment. Attacker subsets are not searched either: adding an attacker can never lower
  guaranteed damage, so "swing with everything eligible" is optimal by construction.
  ⚠️ **Every bound over-estimates the DEFENCE, on purpose**, so `guaranteedDamage` is a lower bound and a
  claimed lethal is never one that is not there. It can miss a kill; it cannot invent one. That asymmetry
  is what makes `takeProvenLethal` (brief §45's router branch) safe to *act* on rather than merely score.
  A first-striking blocker that kills a trampler stops ALL of its damage — that one is easy to get wrong
  in the unsafe direction and is the only place the bound is not "generous by default".
  👉 **THE SUITE HAS TWO HALVES BECAUSE ONE WAS NOT ENOUGH, and finding that out is itself a result.**
  12 pilot puzzles (lethal · anti-lethal · combat · removal · sequencing · mana) score heuristic 10/12 and
  BOTH hybrid arms 11/12 — **a pilot-level puzzle cannot isolate a leaf evaluator**, because on any board
  small enough to state as a puzzle a 160-simulation search just plays it out and reaches the terminal
  whatever its evaluator believes. So the second half grades `evaluateState` DIRECTLY on 5 position PAIRS
  that are both reachable successors of one decision. There: **default 0/5, tactical 5/5** — three pairs
  the default cannot tell apart at all (identical to 4 d.p.) and two it orders backwards.
  👉 **That also explains the null result and says when to re-ask it.** These terms describe positions
  near a terminal, which is exactly where the search does not need help. **Re-ask when the SEARCH
  changes, not when the weights do** — `THRIFTY_HYBRID_CONFIG`, a shallower `maxTreeDepth`, or decks whose
  games are decided further from a terminal all move that balance. A learned value function (§31) is the
  other consumer these terms were built for.
  ⛔ **A LIVE DEFECT THE SUITE CAUGHT IN THE *DEFAULT* PILOT — reported, deliberately NOT fixed.** Given a
  Mountain in play and a Mountain, a Swamp and a `{1}{B}` removal spell in hand, **every pilot plays the
  Mountain** and leaves its own removal uncastable for a turn: `heuristic.ts`'s land-drop candidates score
  each land on its own merits and never ask what a land UNLOCKS. Fixing it changes `heuristic`, which is
  `DEFAULT_PILOT_ID`, so it invalidates every recorded baseline in DESIGN §3.4a and every A/B verdict
  measured against them — that needs its own branch and its own measurement. Pinned as an explicit
  `DEFECT (unfixed)` test that FAILS the day someone fixes it.
  ⚠️ **RULE 7 — the heuristic path is untouched and provably so.** `heuristic.ts`, `weights.ts`,
  `card-value.ts`, `effect-value.ts`, `choices.ts` are **byte-identical to `main`** (`git diff` empty),
  the heuristic never calls `evaluator.ts`/`tactical.ts`, and `npm run sim -- gauntlet "Mono-Red Aggro"
  --games 40 --seed 99` reproduces **92/280 = 32.9%** at 113 games/sec — inside the recorded 109–118 band
  *while two benchmarks were running on the same box*. The hybrid default is unchanged too: with the
  tactical weights at zero the solver is never called, proven by a behavioural test rather than by
  inspection (two boards that differ only in something only the solver can see must score identically).
  👉 **NEW SEAMS in `packages/ai`, all additive:** `assessAttack` / `assessPosition` / `lethalAttackers`
  over a `CombatAssessment` (`maxDamage`, `guaranteedDamage`, `lethal`, `turnsToKill`), plus
  `AttackHorizon` — `'now'` vs `'next'`, which is the seam that lets an evaluator see a crack-back. Two
  bench modes: `tactical <n>` (interleaved arms + the ablation via `BENCH_TACTICAL_ARMS`) and
  `tactical-duel <n>` (the two evaluators playing each other — the sensitive form, since everything they
  share then cancels per game rather than only in expectation).
  ⚠️ **I touched TWO existing tests, both because they were over-specified, not because behaviour
  regressed.** `evaluator.test.ts`'s "zeroing the blend" now zeroes the new weights too. And
  `tree-reuse.test.ts`'s maxNodes-cap test asserted `reuseHitRate === 0`, which is a claim about which
  tree SHAPES one particular game happens to produce — a matched node with no children is one node and
  legitimately fits under a cap of one. It now states the intent as a COLLAPSE against an uncapped arm on
  the same seeded game (>0.5 vs <0.1), which is the property the test was actually for.
  ❌ **NOT done, and not mine:** burn-to-face lethal is not in the router (it needs `effect-value` to say
  how much damage a card in hand deals to a face — a different question with different failure modes; the
  policy already scores lethal burn at the top of its range). No belief model, no determinization
  (§13–17) — those are now UNBLOCKED by `feat/pilot-observation`'s seam, which landed on `main` while this
  branch was measuring, and they are a branch of their own.
  🔀 **Merged `origin/main` in** (which had gained the observation seam + the attachment cards). Three
  conflicts, all resolved in main's favour plus my addition: **my DESIGN section is renumbered §3.4c →
  §3.4d** because `feat/pilot-observation` took §3.4c first, and the two COORDINATION blocks are simple
  appends. `packages/ai/src/index.ts` auto-merged — the two branches added disjoint export blocks — and
  `pilot.ts`'s new optional `TObserver` type parameter has a default, so nothing here needed changing.
  `npm run verify` re-run after the merge, still exit 0.
  (Worker — pushed, NOT merged.)
- 2026-08-15 worker: `feat/attachment-cards` 🚧 PUSHED — **the attachment seam is no longer inert: the
  pool went from ZERO Auras and ZERO Equipment to 14 + 14.** `npm run verify` exit 0 — **2156 passed /
  0 failed** (main baseline 2117 + 39 new), lint 0 errors, `npm run build` exit 0. Pool **156 → 191**;
  both card indexes regenerated, never hand-edited.
  👉 **NOTHING WAS HAND-WRITTEN INTO EITHER INDEX.** Names → `expansion-candidates.json` →
  `build-expansion.ts --fetch` → `build-expansion.ts` → `npm run fetch -w @jonny-boi/data-tools` →
  `npm run cards:index -w @jonny-boi/web`. Every accepted card is the OUTPUT of the real Oracle
  compiler on its real Scryfall text, so `fidelity.test.ts` (which re-compiles every pool card and
  demands an exact match) covers the new cards automatically. **Art verified live with GET, not HEAD**
  — Scryfall's CDN answers 400 to HEAD — all 35 new rows resolve.
  ❗ **THE RE-RUN CAUGHT UP A STALE POOL: 7 NON-ATTACHMENT CARDS CAME IN FOR FREE, and that is the
  finding worth acting on.** `expanded-pool.ts` had not been regenerated since several compiler
  branches landed, so the pool was behind the COMPILER, not behind Scryfall. Re-running the generator
  admitted **Shivan Dragon, Mind Stone, Guttersnipe, Pyroclasm, Thragtusk, Night's Whisper, Unsummon**
  — all faithful, all checked by eye against the printed text committed above each definition.
  ⚠️ **So `build-expansion.ts` should be re-run whenever a compile rule lands, not only when the
  candidate list changes.** Nothing enforces that today and nothing failed while the pool was stale:
  the generator's output is committed, so a compiler that got smarter is invisible until someone
  re-runs it. Verified this re-run drifted NOTHING else: of the 156 existing index rows, **0 changed
  id, 0 changed art, 0 changed oracle text**, and every one of the 124 previously-compiled definitions
  is byte-identical.
  👉 **OBSERVED PLAYING, not just green.** Real games, real heuristic pilot, real pool definitions:
  · `Serra's Embrace` onto Savannah Lions — **2/1 → 4/3**, `flying`+`vigilance` granted; a second copy
    stacks it to **6/5** (so my first assertion of a flat +2/+2 was wrong and the ENGINE was right).
  · `Dead Weight` aimed at the opponent — 2/2 Walking Corpse becomes a 0/0, **dies to an SBA**, the Aura
    unattaches and is **put into the graveyard** (CR 704.5m).
  · `Bonesplitter` — Equip {1} **activated** by the pilot, host **2/2 → 4/2**; when the host dies the
    Equipment **unattaches and STAYS on the battlefield** (CR 704.5n, the whole difference from an Aura)
    and is then re-equipped onto a new creature. Three copies stack to 8/2.
  · `Loxodon Warhammer` — host **2/2 → 5/2** with `trample` and `lifelink`.
  ⛔ **NEEDS AN OWNER IN `packages/ai` (reported, not fixed — that package is live for two branches).
  The pilot PING-PONGS an Equipment between two creatures.** Measured, one game, seed 4242, two
  IDENTICAL vanilla 2/2s: Loxodon Warhammer was equipped **5 times, hosts 1 → 13 → 1 → 13 → 1**, i.e.
  **3 of the 5 activations returned it to the host it had just left**, paying {3} each time for a board
  it already had. The existing guard in `attachments-play.test.ts` only covers the ONE-creature case
  ("does NOT re-equip the creature it is already on"), which is why this survived. The equip heuristic
  needs hysteresis — a move should have to beat staying put by a margin, not merely tie.
  👉 **ONE COMPILER FIX, and it is a normalization gap rather than a new template** (`compile/text.ts`):
  `SELF_PHRASES` folded "this creature/permanent/artifact/enchantment/land/card" into `~` but **not
  "this Aura" / "this Equipment"** — the subtype is how Oracle templates an attachment's self-reference.
  Without it "When this Aura enters, draw a card" survived normalization and looked like an ability
  about some other object. Two words unlocked **Angelic Gift** and **Dark Favor**, and it also makes
  Rancor/Claustrophobia report a clean `~`-normalized clause instead of a raw one. Blast radius is
  confined to Aura/Equipment-typed cards, of which the pool previously had none.
  ⚠️ **`paired-arms-config.ts` NOT touched and did not need to be** — every new card compiles to
  primitives that already exist (`attachToTarget` was classified LIBRARY_SAFE by `feat/attachments`,
  and the ETB triggers reuse `drawCards`/`loseLife`). No new primitive, no classification decision.
  ❌ **Rejected on fidelity grounds, deliberately** (each named in `expansion-report.json` with the
  system it needs): **Pacifism** (can't attack or block), **Rancor** (returns itself from the graveyard),
  **Spirit Mantle** (protection), **Ethereal Armor** (dynamic P/T), **Firebreathing** / **Shiv's
  Embrace** / **Gaea's Embrace** (an ability granted to the HOST), **Aqueous Form** / **Whispersilk
  Cloak** / **Madcap Skills** (can't-be-blocked and menace), **Skullclamp** / **Elephant Guide** /
  **Armadillo Cloak** (triggers on the equipped/enchanted creature), **Flayer Husk** (living weapon),
  **Ghostfire Blade** (a conditional equip cost — the plain half compiles, the narrowed half must keep
  reporting or it would be cheaper than printed), **Darksteel Axe** (indestructible), **Silverskin
  Armor** / **Sinister Strength** (type/colour changes), **Hyena Umbra** / **Snake Umbra** (totem armor).
  ⚠️ **Green has no mono-green Aura and that is a real gap, not a shortfall of effort.** Nearly every
  green Aura in Magic is an umbra, a regenerate-granter or dynamic. The single highest-value engine
  work for Auras is **"can't attack or block"** — it alone unlocks Pacifism and its whole family.
  👉 Two small leave-it-better fixes: `build-expansion.ts` emitted `{  }` for an empty record (my
  cards were the first to print one — a modification granting no keywords), now `{}`; and the stale
  "Both lists are 156 cards today" comment in `apps/web/src/views/LabView.tsx` is replaced with a
  count-free sentence so it cannot go stale again. **That LabView line is my only edit outside my
  owned files** — expect at most a one-line conflict there.
- 2026-08-15 worker: `feat/pilot-observation` 🚧 PUSHED — **the blocker `feat/tree-reuse` reported is
  gone: a pilot can now see the half of the game it does not play.** `npm run verify` exit 0 — **2027
  passed / 0 failed** (baseline 2012 + 15), lint 0 errors, card-index clean, `npm run build` exit 0.
  DESIGN §2 + new §3.4c.
  👉 **THE SEAM IS SPECTATOR-LEVEL, NOT PER-SEAT, AND THAT IS THE WHOLE ANTI-CHEAT ARGUMENT.** An
  `Observation` carries only what someone beside the table holding no cards would know, so **there is no
  seat whose entitlement could be computed wrongly** — the failure mode of a per-seat feed is a masking
  bug, and the failure mode here is nothing, because nothing in the feed is anybody's secret. It also
  makes the feed **one projection per event instead of one per seat**, which is where the cost went.
  A pilot combines it with the view it is already lent (which holds its own hand), so no seat loses
  anything it is entitled to.
  ⚠️ **THE WORST LEAK IN THE UNION IS `gameStart.seed`, AND IT READS LIKE BOOKKEEPING.** It is the number
  both libraries were shuffled from — a pilot holding it has perfect information about the entire game,
  not "a bit extra". Also redacted: `drawCard` (that a draw happened, never which card), `zoneChange`
  (the instance id survives only when the card came to rest somewhere **public** — the test is the
  DESTINATION, since a bounce is watched by everyone and then vanishes), and the three choice events (an
  effect authors its own prompt and may name the cards it is asking about — the same reasoning
  `@jonny-boi/protocol`'s `RedactedPendingChoice` already uses; the two redactions agreeing is deliberate).
  35 of core's 41 event types pass through untouched.
  ⚠️ **THREE GATES, AND ONLY ONE OF THEM IS WORTH ANYTHING ON ITS OWN.** (1) `OBSERVATION_POLICY` is a
  mapped type over `GameEvent['type']`, so a new core event breaks the sim build until classified —
  same shape as `paired-arms-config.ts`. (2) `'public'` is **unspellable** for the six redacted types:
  each replacement shape declares its dropped field `?: never`, so the raw event is not assignable, and
  `REDACTION_IS_UNSPELLABLE` fails to compile if any is weakened (verified by deleting one). (3) The
  real one: `observation.test.ts` plays real games and scans every delivered observation with protocol's
  `collectInstanceIds` against the cards **actually in a hand or library at that instant**. **Verified
  RED by sabotage** — un-redacting `drawCard`, then `zoneChange`, each makes the scan name the exact
  leaked cards. A green anti-cheat test that cannot go red is worse than none.
  ❗ **`REDACTION_IS_UNSPELLABLE` LIVES IN SHIPPED SOURCE, NOT IN THE TEST FILE, AND THIS IS A TRAP
  EVERYONE SHOULD KNOW ABOUT.** `packages/*/tsconfig.json` **excludes `src/**/*.test.ts`** and Vitest
  strips types without checking them, and eslint here is not type-aware. **A `@ts-expect-error` written
  in a test file in this repo is evaluated by NOTHING.** I wrote six of them, then checked, then moved
  the guarantee into a compiled file. Anyone writing a type-level assertion here must do the same.
  👉 **PER-GAME ISOLATION IS STRUCTURAL BY CHOOSING THE OTHER SEAM SHAPE.** The obvious design is
  `Pilot.observe(obs)`, and it is the wrong one: it forces per-game state onto an object that is reused
  across hundreds of games. The seam is `Pilot.createGameObserver(info)` — the harness creates one per
  game, hands it back on every `DecisionContext`, and drops it at the end, so **a pilot has nowhere to
  put cross-game state**. This is not tidiness: every real consumer builds ONE pilot and runs MANY games
  through it, and the Lab shards the grid across workers by range, so a belief that outlived a game would
  make a paired A/B verdict **depend on the worker count**. Pinned by a test that plays one game
  standalone and again after three others through the same pilot and demands a byte-identical transcript.
  ⚠️ **DETERMINISM — digested, not asserted.** sha256 over the FULL chosen-action sequence, **131,524
  plies** (`heuristic`, `random` AND `hybrid` × three matchups): **all nine digests identical** before and
  after, measured by building the pre-seam sources in the same worktree. `npm run sim -- gauntlet
  "Mono-Red Aggro" --games 40 --seed 99` diffs **byte-identical except the throughput line**. None of the
  four built-ins implement the seam, so `observers` is `null` and the loop is the old loop.
  👉 **COST: public events are delivered BY REFERENCE; only redacted ones allocate.** Measured over 20
  games — 1,128 events/game, **96.9% by reference, 3.1% (35/game) copied**. Interleaved **in-process** A/B
  with the pre-seam and post-seam harness both loaded (alternating which arm runs first, because this box
  warms up over a run): 21 rounds × 250 games → **paired median 0.989×**, i.e. parity, against a per-round
  spread of **0.79–1.18**. An 11-round run of the same code said 0.956× — quote the paired median of the
  longer run, and never a single round. Feed **ON at both seats**: **0.963×**, n=15.
  👉 **Proof of life, deliberately NOT a belief model:** `createOpponentRevealObserver` tallies what the
  opponent has publicly revealed this game (cards drawn, lands, spells by name, mana by colour, ids that
  entered public view — the raw material for §16 known cards, §32–33 archetype and §35–37 represented
  mana). `createRevealTrackingPilot(base)` wraps any pilot and delegates the decision unchanged, which is
  what lets a test prove observing costs no change in play. Re-runnable:
  `node packages/sim/bench/observation-bench.mjs digest | throughput | plain | volume`.
  ⛔ **NEEDS AN OWNER ELSEWHERE — reported, not done:**
  · **`DecisionContext.view` is the FULL, UNMASKED `GameState`.** A pilot can read
    `view.players.B.hand` and `view.players.B.library` today, and `view.seed`. This seam does not make
    that worse (it is the reason the feed had to be provably clean), but the honest statement is
    "observations cannot leak; the VIEW already does". `PILOTS_THAT_READ_HIDDEN_LIBRARY` in
    `paired-arms-config.ts` exists precisely because `mcts` exploits it. Masking the view is a
    cross-package decision (`packages/ai` + `packages/sim` + every pilot) and belongs on its own branch —
    a belief model built against an unmasked view would be measuring nothing.
  · **`apps/server` and `apps/web/src/lib/replay-build.ts` call `chooseAction` themselves** and do not
    drive the seam. That is safe and by design (`ctx.observer` is optional and the wrapper tolerates its
    absence — tested), but a pilot that ever needs observations *in online play* would need the same
    ~10 lines in `apps/server`'s room loop. Not touched.
  · `packages/sim` gained `@jonny-boi/protocol` as a **devDependency** (test-only, for
    `collectInstanceIds`). Deliberate: re-implementing "does this mention that card?" is exactly the drift
    the room-code bug taught us about.
  ⚠️ **For `feat/tactical-eval` / whoever else is in `packages/ai`:** my footprint there is 2 new files
  (`observation.ts`, `reveal-tally.ts` + its test), an additive block in `index.ts`, and `pilot.ts` —
  where `Pilot` and `DecisionContext` gained an optional `TObserver` type parameter **with a default**, so
  every bare `Pilot` / `DecisionContext` annotation in the repo is unchanged. Plus one stale comment
  corrected in `tree-reuse.ts` (it said the observation channel does not exist). `evaluator.ts`,
  `hybrid.ts` and `mcts.ts` are untouched.

- 2026-08-15 worker: `feat/pilot-relative-verdicts` 🚧 PUSHED — **every result now says which pilot
  produced it, and the suggestion engine refuses to pool two pilots' evidence.** `apps/web` ONLY; nothing
  in `packages/*` touched. Suite **1969 passed / 0 failed** (baseline 1939 + 30), `npm run lint` 0 errors,
  card-index `--check` clean, `npm run build` exit 0. DESIGN §3.7a added.
  👉 **THE HEADLINE IS THE ONE `feat/hybrid-search` LEFT BEHIND.** Its own note said "deck verdicts are
  pilot-relative — worth stating in the Lab UI at some point". Doing it turned out not to be a label job:
  a win rate is a measurement of a deck AS PLAYED BY a pilot, so the pilot had to become a first-class
  field on the request, the shard context, the result payload and the stored record. `pilotId` is
  **REQUIRED** on `SimRequest`, not optional-with-a-default — an optional field is one a call site can
  forget, and the call site that forgot it would silently answer a different question than the screen
  displays. (Same lesson as the room-code bug: a value two layers each default separately is a bug
  waiting.)
  ⚠️ **THE STATISTICALLY LOAD-BEARING PART IS THE HISTORY PARTITION, and "invalidate on change" would
  have been wrong.** `lib/sim/history-store.ts` accumulates cross-run evidence, and TWO of its fields make
  pooling across pilots invalid rather than untidy: (1) `settled`/`provenNotBetter` retire a candidate
  from future runs, and "not better" is a claim about a LEVEL OF PLAY — a card whose value is punishing
  bad blocks is settled-as-useless under one pilot and a real gain under another; (2) `candidates.length`
  IS the Holm–Bonferroni family size, so pooling both inflates the family and corrects a family that mixes
  two different hypotheses. **Chosen: partition by pilot in the storage key, keep every record side by
  side.** Deleting on change was rejected outright — a record can be hours of compute and "you moved a
  dropdown, so your afternoon is gone" is not a trade to make on a user's behalf. The UI PROVES the
  partition is not a deletion ("Kept separately: Heuristic (3 runs). Switch pilot to resume."), because a
  partition nobody can see is indistinguishable from losing the data, and a user who believes it is gone
  will hit Reset and make it true.
  👉 **Pre-partition records are ADOPTED, not dropped.** Everything written before this branch was played
  by `DEFAULT_PILOT_ID` — nothing else could be run — so the old key is read once, re-filed under the
  default pilot's key, and only then removed. If the migration WRITE fails (quota), the old key is kept:
  a migration is the one moment a storage failure could destroy evidence rather than merely fail to add
  to it. Both paths are unit-tested.
  ⚠️ **THE COST WARNING HAD TO COME BEFORE THE RUN, AND MY FIRST CALIBRATION WAS 4× TOO OPTIMISTIC.**
  Hybrid is ~1400× the heuristic, so the same gauntlet is 3 seconds or an hour on one dropdown. Each panel
  now shows its planned game count and a wall-clock estimate NEXT TO the Run button before it is pressed.
  I first calibrated `REFERENCE_GAMES_PER_SECOND_PER_WORKER` from the headless figures on this board
  (110–206 games/sec on one core) and the estimate came out ~4× short of what the Lab actually did. **The
  browser numbers are the only honest calibration for a browser estimate:** a real 700-game gauntlet in
  the running Lab reported **192 games/sec on 11 workers** (~17.5/worker), so the constant is 20 — the
  pessimistic end, because an estimate that runs short is the one that gets somebody to start an overnight
  run by accident. If you re-measure, measure END TO END (games/sec), not per decision: under the
  heuristic the ENGINE dominates a game's cost, so scaling a whole game by a per-DECISION ratio overstates
  a search pilot badly.
  👉 **Verified in the running app, not just in tests** (dev server on the worktree, `localStorage`
  inspected): a 700-game heuristic gauntlet renders the provenance stamp + "· pilot heuristic"; a
  suggestions run files itself under `jonny-boi.suggest-history.v1.heuristic.<fingerprint>`; switching to
  Hybrid shows a FRESH search plus "Kept separately: Heuristic (1 run)"; switching back restores "Run 2 ·
  28 candidates carried over"; the Hybrid estimate reads "~780 games · estimated 1 hour on 11 workers —
  this is a long run".
  ⛔ **ONE CHANGE WANTED OUTSIDE `apps/web`, reported not made** (`packages/sim` is live for other
  branches): `SuggestionHistory` has `version` + `deckFingerprint` but no `pilotId`, so the sim's own
  `acceptHistory` cannot reject a cross-pilot record — only this web layer can. It works because the web
  layer wraps the record in an envelope carrying the pilot and checks it, but the CLI's `--history <file>`
  has **no such guard**: `npm run sim -- suggest deck --pilot hybrid --history h.json` will happily accept
  a file gathered with `--pilot heuristic`. The right fix is a `pilotId` field on `SuggestionHistory` and
  a third clause in `acceptHistory`; then the web envelope becomes belt-and-braces instead of the only
  belt.
  ⚠️ Also for whoever owns `packages/ai`: adding a pilot to `SELECTABLE_PILOT_IDS` will fail ONE assertion
  in `apps/web/src/lib/sim/pilots.test.ts` ("has display copy and a measured cost for every selectable
  pilot"). That is deliberate and the fix is two rows in `lib/sim/pilots.ts` — the app already runs
  without them (unknown pilots are shown, priced as "not measured", and treated as costly), so it is a
  reminder, not a blocker.
  ❌ **Not done:** no hook/component tests — `apps/web` still has no `@testing-library/react`/jsdom, and
  adding that stack is the separate decision the board already flagged. All new logic is pure and unit
  tested instead (`pilots.test.ts`, the rewritten `history-store.test.ts`, `estimateSuggestionGames`).
  The pilot choice is also NOT persisted across a reload (it lives in `useLabSelection`, like the seed).
- 2026-08-15 worker: `perf/core-hotpath` 🚧 PUSHED — **`planManaPayment` is 1.9–2.7x faster and allocates
  86% less; the "kill the clone" ceiling is NOT 1.53x and the reason is that the clone is already gone.**
  `packages/core` only (`mana-plan.ts`, new `mana-plan.test.ts`, a new section in
  `bench/engine-alloc-bench.ts`). `npm run verify` exit 0 — **1957 passed / 0 failed** (baseline 1939 + 18
  new), lint 0 errors, `npm run build` exit 0.
  👉 **THE COST WAS THE OBJECT SHAPE, NOT THE SCAN — and the brief's suggested fix is the one thing that
  makes it slower.** Building a `Map` index of the battlefield per call measured **0.92–0.98x at 2,272
  B/call** against 1,854 for the linear scan, on 600 real mid-game positions. The 20-odd `===` the scan
  performs are nearly free; what was NOT free is that a `ManaCost` and a `ManaProduction` are SPARSE
  partial records (`{R:1}`, `{generic:2,W:1}`), so **every card in a deck presents a different hidden
  class and `cost[color]` in the ranking loop is a MEGAMORPHIC load** — six of them per candidate tap per
  step of the plan. Reading each sparse record ONCE into a dense `Int32Array` and ranking against that is
  where the whole win lives. The scan stayed; the old comment defending it was right and is kept (with
  the re-measured numbers).
  👉 **Measured, in-process, interleaved A/B of seven variants** (600 real positions, Mono-Red vs Boros,
  old implementation copied verbatim as the control so both run in one process):
  linear scan → allocation-free indexed scan **1.08–1.14x**; + array-of-groups instead of
  `Map.values()` **1.19–1.38x**; + dense reused buffers **1.77–2.73x at 262 B/call vs 1,854 (−86%)**.
  Re-measured on `packages/core/bench/engine-alloc-bench.ts`, interleaved, core-only: **4.03 → 2.13
  µs/call (1.89x median, 1.95x best-of)**, with actions/sec and ns/clone at parity.
  `packages/ai/bench/mcts-bench.mjs instrument`: **8.21 → 6.36 µs and 5.32 → 0.34 KB per call (−94%)**,
  allocation/decision 19.75 → 16.25 MB. End to end, interleaved by swapping `packages/core/dist`:
  heuristic gauntlet **+5% median**, hybrid match **1.12x best-of / 1.24x median**.
  ⚠️ **DETERMINISM, proved four ways, not asserted.** (1) A full-decision-sequence sha256 over **28,108
  plies** — heuristic on two matchups (20 games each) and the HYBRID pilot on two matchups — is
  **identical** before and after. (2) `npm run sim -- gauntlet "Mono-Red Aggro" --games 40 --seed 99` and
  `-- match … --pilot hybrid` diff **byte-identical except the throughput line**. (3) The seven variants
  were required to return the identical plan on all 600 positions. (4) `selfplay-lock.test.ts` unchanged.
  👉 **NEW: `packages/core/src/mana-plan.test.ts` (18 tests) — the hottest function in the engine had NO
  direct test.** It is public API for both pilots, the hotseat auto-tap and the online client, and it was
  only ever exercised indirectly. The tests pass against the OLD implementation too (checked), so they
  are a real equivalence guard rather than a rubber stamp for the new one. They pin the two tie-breaks,
  "a source's modes are alternatives", grouping when the offered modes are **non-contiguous** (the online
  client filters its own action list, so grouping must not depend on engine ordering), and the three ways
  the new reused module-level buffers could leak between calls.
  ❗ **THE CLONE ANSWER IS "ALREADY DONE", AND ANYONE QUOTING 1.53–1.58x IS QUOTING A DEAD NUMBER.**
  `DEFAULT_SIM_CONFIG.applyActionsInPlace` is **true**, so `match.ts` already runs `applyActionInPlace`;
  MCTS and the hybrid roll out in place too. **There is no remaining hot-path caller of the cloning
  `applyAction` in this repo** — the others are `apps/web` session + replay-build and `apps/server` room,
  all one action per human/network event, all genuinely needing the previous state. So the spike's ~1.58x
  ceiling (correct for clone-per-ACTION) no longer describes the code.
  👉 **What IS left is one clone per SIMULATION in the search, and I measured its real ceiling:**
  the hybrid's budget is 160 simulations = 160 clones per decision, which is **19.0% (median) / 16.9%
  (best-of) of a decision** → **ceiling 1.23x / 1.20x if cloning were FREE**, on 10 real positions,
  9 interleaved rounds.
  👉 **The one structural lever, measured but deliberately NOT taken: 85% of the instances a clone copies
  are LIBRARY cards.** Sharing library instances instead of copying them makes the clone **3.3x cheaper**
  (2.61 vs 8.66 µs, 4.12 vs 14.70 KB) — but that is worth only **1.15x** on a hybrid decision and NOTHING
  on the Lab's default heuristic gauntlet, and it buys that by introducing an invariant ("no `CardInstance`
  is mutated while it sits in a library") that is unenforced today, whose violation aliases two states and
  corrupts the search's root **silently**. That trade needs its own branch with the invariant made
  mechanical (a dev-mode freeze + a sabotage test), not the tail of a perf branch. ⚠️ Note the byte
  counters in that comparison are distorted by V8 escape analysis on the inlinable control arm; the time
  ratio, the byte ratio and the 85% instance share agree, which is why it is quoted as "3–4x".
  ❌ Also NOT done and NOT mine: `packages/ai` could reuse ONE state buffer across simulations
  (refresh-in-place instead of `cloneState` per simulation) — that removes the ALLOCATION without removing
  the copying, and it is a `hybrid.ts`/`mcts.ts` change. Reported, not made.
  ⚠️ **Measurement discipline:** sequential runs "showed" this change as a 17% SLOWDOWN (143 → 119
  games/sec) — pure drift; the interleaved run of the same builds showed +5%. Every number above is
  interleaved inside one process or by alternating `packages/core/dist` between two prebuilt copies.
- 2026-08-15 worker: `feat/tree-reuse` PUSHED — **brief §21–22 built, measured, and shipped OFF. The
  measurement IS the deliverable; read the numbers before turning it on.** `packages/ai` only, plus
  DESIGN §3.4b. Stacks on `feat/hybrid-search` (merge that first). Suite **1961 passed / 0 failed**
  (baseline 1939 + 22), `npm run verify` exit 0, `npm run build` exit 0, lint 0 errors.
  👉 **THE MATCH IS BY POSITION, NOT BY ACTION, AND THAT IS FORCED.** The brief says "promote the child
  matching the real action". You cannot: `Pilot.chooseAction` is called ONLY when we hold priority, so a
  pilot **never observes the opponent's actions at all** — §22 is not implementable on action matching
  without a new observation callback on `DecisionContext`, i.e. a change in `packages/sim`. A pilot also
  cannot know how many engine actions passed (forced windows are compressed inside the search, our own
  macros span plies, a committed macro can abort half-way). So every node records a 64-bit
  `fingerprintPosition` of the whole state and the live position is LOOKED UP. Our move, the opponent's
  moves and any forced run in between all collapse to one mechanism, and `packages/sim` stays untouched.
  👉 **`actionEquivalenceKey` is the WRONG key for that and the RIGHT key for what it already does.**
  It answers "are these two offered actions the same DECISION" and deliberately merges actions whose
  STATES differ (Island #7 vs #12 tapped for {U}). Re-rooting on it would adopt a search of a position
  that is not the one on the table. It IS still used to line a retained edge up against the freshly
  derived candidate list — the same question asked *within one position*.
  ⚠️ **DETERMINISM — the conclusion, and it is structural rather than careful.** Reuse makes a decision
  depend on what this pilot instance searched EARLIER. That is safe because `GameState.seed` is mixed into
  the fingerprint and the retained tree records its deciding seat, so a tree can only ever be reused
  **inside the one game and the one seat it was built in** — where the sequence of positions is itself a
  function of the seed. This is not decoration: every real consumer (`sim/cli.ts`,
  `apps/web/lib/sim/execute.ts`, the harness) builds ONE pilot and runs MANY games through it, and the Lab
  shards the game grid across workers by range (`RunOptions.range`, `playSlice`). A tree that survived a
  game boundary would make a paired A/B verdict **depend on the worker count**. Pinned by a test that
  plays two other games through a pilot and then asserts a byte-identical transcript for the target game.
  Nothing here reads the clock or `Math.random`.
  ❗ **HEADLINE: IT WORKS, AND IT DOES NOT HELP.** Interleaved arms on identical seeds; the reuse-OFF arm
  **reproduced BOTH recorded baselines exactly** (72/120 and 43/80), which is what makes the rest
  trustworthy:
  · Mono-Red vs Boros, n=120: OFF **60.0%** [51.1, 68.3] -> ON **60.0%** [51.1, 68.3]; **6.49 -> 8.76 ms**
    mean, p95 59 -> 83 ms.
  · UW Control vs Golgari, n=80: OFF **53.8%** [42.9, 64.3] -> ON **56.3%** [45.3, 66.6]; **10.52 ->
    16.71 ms** mean, p95 97 -> 136 ms.
  The mechanism is emphatically not broken: the live position is found on **94.6% / 95.5%** of decisions
  and carries **217 / 284 inherited visits** into a 160-simulation budget. The search really is ~2.4x
  deeper in information and plays the same. **That is exactly what `feat/hybrid-search`'s own plateau
  finding predicts** (256->1024 sims bought +1.7 points): this pilot is limited by its EVALUATOR, not by
  how much it searches, and reuse only buys more searching. So `DEFAULT_HYBRID_CONFIG.reuse` ships
  **off** — enabling it would be a rule-7 throughput regression bought with a strength gain that is not
  there — and a test pins that with the table attached.
  👉 **WHAT IT DOES BUY, and it is worth having: the same play for HALF the decision time.**
  `THRIFTY_HYBRID_CONFIG` = reuse ON at 64 simulations. Head to head against the 160-simulation default,
  n=120 each: **64 sims -> 46.7%** [38.0, 55.6] at **44%** of its decision time; **96 sims -> 48.3%**
  [39.6, 57.2] at **74%**. Both intervals include 50%, so the honest claim is **"no measurable loss at
  half the cost"**, NOT "stronger" — both point estimates sit just under 50%. It is the beginning of the
  throughput case a search pilot needs before it could ever become the default. `DEFAULT_PILOT_ID` is
  untouched and still `heuristic`.
  ⚠️ **WHY REUSE COSTS MORE PER DECISION — non-obvious, and worth knowing before anyone "optimises"
  it.** In-tree engine plies per simulation go **56 -> 78** (aggro) and **82 -> 119** (control). An
  inherited tree is DEEPER, and every simulation re-applies every macro from the root down to its leaf, so
  a deeper tree makes each simulation cost more. The extra time is the search going deeper, not
  bookkeeping — fingerprints are computed only for nodes within `maxDepth` (4) edges of the root.
  👉 **Stale statistics: measured, not guessed.** `decay: 1` (inherit as they stand) vs `decay: 0.5`
  (visits and reward scaled TOGETHER, so every mean is preserved exactly and only confidence shrinks) over
  the identical 120 games: **72/120 vs 73/120** — one game apart. Knob kept, default 1; re-ask it when the
  evaluator changes, since the evaluator is what is actually binding.
  👉 **Memory: bounded by construction, and measured.** Promotion prunes every sibling subtree, and a
  retained tree over `maxNodes` (8192) is dropped WHOLE rather than trimmed — a partly-trimmed tree is one
  whose visit counts no longer add up. Measured peak over full games: **294 / 353 nodes**. The cap is a
  guard, not a working limit, and a test drives the drop path with `maxNodes: 1`.
  👉 **NEW SEAMS in `packages/ai`, all additive:** `fingerprintPosition` / `fingerprintsEqual` /
  `findNodeByFingerprint` / `decayAndCountSubtree` over a structural `ReusableNode` — deliberately
  search-agnostic, because brief §18 (transposition tables) and §11 (a tactical solver) want the same
  position key, and two different answers to "is this the same position" is exactly the kind of drift this
  repo has already been bitten by. `DecisionStats` gains
  `reuseAttempts` / `reuseHits` / `reusedNodes` / `reusedVisits`. Two new bench modes: `reuse <n>`
  (interleaved OFF/ON arms on PAIRED seeds; `BENCH_DECAYS=1,0.5`) and `reuse-duel <n>`
  (`BENCH_ON_SIMS=<k>` — the arms playing EACH OTHER, the sensitive form of the question, because
  everything the two arms share then cancels per game rather than only in expectation).
  ⚠️ **MEASUREMENT NOTE.** Win rates needed no interleaving and are exactly comparable with the numbers
  already on record — the sim is deterministic in the seed, so an arm's win count is the same whenever it
  runs. Interleaving is purely for the MILLISECONDS. Do NOT compare decision times ACROSS runs: the OFF
  arm measured 7.69 ms in one duel and 5.04 ms in another on identical config, because decision cost is
  board-size dependent and the two runs faced different opponents. Only within-run ratios are quotable.
  ⛔ **NEEDS AN OWNER OUTSIDE `packages/ai`** (reported, not done — I own only `packages/ai`):
  · **`DecisionContext` gives a pilot no way to observe what the OPPONENT did.** Not needed for this
    branch (position matching sidesteps it entirely), but every belief-model / opponent-model item in the
    brief (§13–17, §32–33) needs it, and it is a `packages/sim` seam change.
  · The `planManaPayment` O(sources x battlefield) rescan that `feat/hybrid-search` reported in
    `packages/core` is still the hottest thing the policy does; reuse does not touch it.
  (Worker — pushed, NOT merged.)

- 2026-08-15 integrator: **`fix/room-code-length` MERGED + DEPLOYED** (Deploy PWA success).
  main = **1887 tests, build exit 0**. USER-REPORTED: PC hosted, phone entered the code, Join stayed
  greyed and did nothing.
  🐛 **Online play has never been joinable.** `ROOM_CODE_LENGTH` was declared TWICE — **5** in
  `apps/server/src/config.ts`, **6** in `apps/web/src/lib/online/online-config.ts` — and the Join
  button gates on the client copy. Every genuine code is 5 chars, so the button could never enable.
  Neither side was wrong alone, which is why nothing caught it: each package tested itself and
  agreed with itself. **The bug lived in the gap between two packages.**
  ✅ Fix: the room-code shape (length, alphabet, wire bound) now lives ONCE in
  `@jonny-boi/protocol` — the shared contract is exactly where a value the server ISSUES and the
  client TYPES BACK belongs. Both sides re-export; neither declares. Plus `normalizeRoomCode` /
  `isPlausibleRoomCode` so a lowercase or space-padded code still works on a phone.
  🧪 Guards at both ends AND across the seam: 200 server-generated codes must each pass the
  CLIENT validator, and both configs must re-export rather than re-declare. **Verified live**, not
  just in unit tests — created room "MJT4G" on a local server and joined it from a second socket
  with the code lowercased; both seats appeared.
  👉 **NO NAS REDEPLOY NEEDED** — the server already issued 5-char codes and its behaviour is
  unchanged. The fix ships with the web app.
  👉 Lesson worth generalising: **a constant both packages need is a contract, not a config.** If
  you find yourself typing the same name in two packages, it belongs in `protocol` (or `core`).
  Also: a disabled control must say why — this one silently refused valid input for its whole life,
  which is indistinguishable from broken.

- 2026-08-15 integrator: **NAS server is now LIVE on protocol v2, and backward compatible.** Verified
  against `wss://jonnyboi.duckdns.org:8443` after the restart: v1 ACCEPTED, v2 ACCEPTED, v3 and v0 both
  REJECTED. Rollback bundle is on the NAS at `/docker/jonny-boi/backup/server.cjs` (361,992 bytes, the
  previous build); live is 402,745.
  👉 **Do not ship a server bundle without checking `Room.protocolMatches` first.** It was strict
  equality (`version === PROTOCOL_VERSION`), which made `MIN_COMPATIBLE_PROTOCOL_VERSION` dead code and
  compatibility ONE-directional — a new client could talk down to an old server, but an old client was
  locked out of a new one, with no downgrade logic to recover with. Restarting onto v2 would have
  blacked out every stale cached PWA. Fixed + tests pin both directions.
  👉 **Deploying to the NAS: drive the DSM *webapi*, not the DSM desktop UI.** Loading the desktop
  wedges the Chrome renderer (screenshots and JS both time out, and it starves sibling tabs). Get the
  CSRF token from `/webman/login.cgi` on the existing session, send it as `X-SYNO-TOKEN`, then use
  `SYNO.FileStation.Upload` / `SYNO.Docker.Container`. NAS is **10.0.0.28**.
  ⚠️ A single-file Docker bind mount **pins the inode** — replacing `server.cjs` is invisible to the
  running container until it restarts. Always back up to `backup/` and confirm the new size/mtime
  before restarting.

- 2026-08-15 DESKTOP-90PJPM4: **`fix/hint-accuracy` MERGED + DEPLOYED** (Deploy PWA green, live
  site HTTP 200). main = **1864 tests, build exit 0**.
  👉 **The unsupported queue was advertising TWELVE solved systems.** UNSUPPORTED-MECHANICS.md is
  generated from the `missingEngineSystem` strings, so a stale one sends the next agent to rebuild
  finished work. These had all shipped since the text was written: activated abilities, sacrifice
  costs, enters-tapped, chosen-colour mana, modal spells, counters, library look/reorder, graveyard
  retrieval, filtered targeting, leaves-the-battlefield triggers, compound draw/lose, static buffs.
  A hint fires only when NO rule matched, so once a system exists the honest message is **"a <kind>
  template the compiler does not recognize yet"** — the engine can do it, the compiler just cannot
  read that sentence. **Treat the hint text as part of shipping a mechanic**: implement the system,
  reword its hint in the same commit, and update the assertion in `compile.test.ts`.
  📋 **The real remaining queue** (these keep their original wording because they are genuinely
  missing): planeswalker loyalty · transform/DFC · flashback · ward and protection-from ·
  alternative/additional costs ({X}, kicker, suspend, spectacle) · variable {X} and derived values ·
  blocking restrictions beyond evasion · gaining control · targets chosen by a triggered ability ·
  optional payment during resolution · named keyword subsystems.
  ⛔ Still-open blocker noted earlier: **gaining control** needs an `effectiveController()` threaded
  through combat/priority/legality before it can be done safely — not a corner of another branch.
  (Integrator)

- 2026-08-15 DESKTOP-90PJPM4: `fix/hero-validation` ✅ INTEGRATED to main (apps/web only).
  One `lib/heroValidation.ts` now serves both the Lab and the Match viewer. `validateHero` was
  defined twice and the copies had DRIFTED: the Lab named the unsupported imported cards, the Match
  viewer did not, so watching a game with an imported deck answered `unknown card "<uuid>"` — an id
  shown nowhere in the UI. Reproduced live in the running app with a real Modern Boros list before
  fixing, not argued from the code.
  ⚠️ For whoever integrates next: this branch predated main's refactor of these views, so the merge
  was resolved to MAIN's version of LabView/MatchView and the extraction re-applied on top. The
  shared module is main's LabView implementation moved verbatim; the only wording change is
  "swap them out to run the Lab" -> "run it", since the Match viewer shows the same string now.
  Two things the lint gate caught that tsc did not: an unused `Deck` import, and a stale comment in
  gauntletDecks.test.ts pointing at "LabView's validateHero". Run `npm run verify`, not just
  `npm test` — lint is part of the gate again.
  STILL OPEN, deliberately not taken: `deckHealth.ts` and `unsupportedCardNames` answer overlapping
  questions from two mechanisms; unifying them touches DeckBuilder + Lab + Match at once, all live
  for other agents. And a compiler defect found while reproducing this — a split card
  ("Wear // Tear") is mis-diagnosed as needing a `"//"` card TYPE and as transform/DFC; only Fuse and
  the targeting clause are genuine. That is `packages/cards/src/compile`, owned by feat/card-mechanics.
- 2026-08-15 worker: `spike/engine-representation` 🚧 PUSHED — **"build the hot path in whatever is
  fastest, possibly C++" — answered with measurements. Full write-up:
  [spikes/engine-representation/README.md](spikes/engine-representation/README.md).**
  **NO product code touched.** New dir `spikes/engine-representation/` (outside the workspaces globs
  and outside the vitest `include`) + **two narrow additions to `eslint.config.js`** — expect a
  trivial conflict there only if someone else edits that file.
  👉 **THE HEADLINE IS NOT WHAT THE BRIEF EXPECTED. The cost is the LANGUAGE, not the data — and
  neither is the thing to do first.** Four arms, all playing **byte-identical games** (transcript
  digest over every decision, `packages/ai/bench/mcts-bench.mjs`'s technique):
  · **A** object graph TS (today's design) · **B** flat `Int32Array` arena + delta undo journal, TS ·
  **B+** a tuned steelman of B · **C** arm B ported line-for-line to WASM.
  **A→B changes only the DATA. B→C changes only the RUNTIME.** Neither comparison existed before.
  ⚠️ **THE FLAT-REPRESENTATION ARM LOSES, and that is the most useful result here.** Flat TypeScript
  is **0.61–0.70× on forward simulation** (a 30–39% SLOWDOWN), stable across three runs. It wins ONLY
  where it replaces *cloning* with *undo* — 1.7–2.8× at rollout depth 1, break-even at ~depth 8,
  a loss beyond. **Mechanism:** `inst.def.power` is two pointer loads V8's inline caches make nearly
  free; the flat equivalent is two BOUNDS-CHECKED `Int32Array` loads, and JS cannot spell "this index
  is already proved in range". This is the same trap `spikes/wasm` hit ("use typed arrays" is not the
  optimisation) — now with the mechanism attached. **Do NOT flatten `packages/core`.**
  👉 **I tried to make the flat arm faster and it got SLOWER — arm B+ is kept in the repo as
  evidence.** Giving every instance its own copy of its card row (removing a load) cost 0.81×: the
  shared 19-card table is 912 bytes and lives in L1, and duplicating it per instance grew it to
  7.5 KiB. The flat result is not a first draft.
  👉 **The LANGUAGE win is real and much bigger than the previous spike's +0.4%: B→C is 2.1–3.5×**
  with the representation held exactly constant. Decomposed by compiling a second WASM with bounds
  checks left IN: **2.0× is codegen alone**, a further **1.43×** is unchecked access. The earlier
  +0.4% was correct *for a kernel*; it is not the number for a whole-engine flat port.
  ❗ **BUT THE ALGORITHMIC LEVER BEATS BOTH AND IS ALREADY IN FLIGHT.** Holding the rollout budget
  fixed and sweeping depth: **terminal rollout → depth-1 leaf eval is 12.2–15.5× on the CURRENT object
  engine with no port at all** (`feat/hybrid-search`). The port's honest marginal value *on top of
  that* is **5.6× / 5.8×** — the steadiest number in the whole spike. **Recommendation: land the
  algorithmic change, then kill the per-action clone in plain TS; revisit WASM only after both.**
  👉 The two levers COMPOUND rather than overlap — shallow rollouts are exactly where clone cost
  dominates and flat+undo wins biggest. The algorithmic change makes a future port *more* attractive.
  👉 **Independent cross-check worth knowing:** calibration says `cloneState` is **36–38% of a real
  action's cost**, so removing it has a ceiling of ~**1.58×** — and `spikes/wasm` measured that same
  ceiling end-to-end at **1.53×** by a completely different method. Two methods agreeing to 3% is the
  strongest evidence in the report.
  ⚠️ **If WASM is ever done it must be ALL-IN, never a hybrid.** "WASM for the sim, TS for play" means
  two rules engines in two languages in the path of a *statistically definitive* A/B verdict — two
  ways for the verdict to drift, showing up as a card being subtly mis-evaluated. Either the engine
  moves wholly, or it stays. The boundary itself is NOT the blocker (~3.3 ns marginal per call,
  18.6 KiB module, batching makes per-call cost immaterial) — but **one state copy-out per action
  costs +51–68%**, and the match viewer / replay / online server / debug inspector all read state
  from JS. Any port must keep those at batch granularity.
  ⚠️ **Arm D (native binary) was NOT measured:** this box has no emcc/clang/rustc/cargo/wasm-pack/g++/
  zig and installing one is a large external download. AssemblyScript came from the npm cache
  (`spikes/wasm` had already fetched it). Arm C is a **lower** bound on native — no autovectorisation
  — but `verify.mjs` proves the emitted `.wat` contains **no garbage collector** and only 3 start-up
  allocations, so it is not paying managed-runtime overhead.
  ⚠️ **HONEST BIAS, stated because it cuts against my own headline:** the model game omits triggered/
  activated abilities, the choice system, attachments, layered statics, modal spells, {X}, and the
  Oracle-text compiler. What it omits is disproportionately the work that does NOT flatten cleanly
  (registry dispatch through function refs, string zone names, `Map` in `indexContinuous`), while what
  it keeps is nearly pure integer/array work — WASM's best case. **Treat 2.1–3.5× as an optimistic
  bound.** Calibration is in the README: instance count is *identical* (120/120) and branching is
  *higher* in the model (3.17 vs 2.00), so the clone/undo result transfers well; ns/action is 13.4×
  apart, so the language result transfers worst.
  ⚠️ **Measurement note for whoever re-runs this:** absolute times moved by a factor of **1.7** between
  runs of identical code, while the key ratios moved by <0.1×. Everything is best-of-9 interleaved
  A/B/C inside one process, three independent runs quoted. One number did NOT resolve and is reported
  as unresolved rather than dropped: the undo journal's cost on a forward-only playout came out 1.08×,
  1.54× and 0.92× — the spread swamps it. Captured outputs are in `spikes/engine-representation/results/`.
  👉 **eslint.config.js — two additions, both generalizable, not spike-specific:** `spikes/**/assembly/**`
  is now IGNORED (AssemblyScript files carry a `.ts` extension but are not TypeScript — `@inline` is a
  decorator in a position tsc forbids, so typescript-eslint fails to PARSE them rather than finding
  anything; this also covers the existing `spikes/wasm/assembly/`), and `WebAssembly` joins the Node
  globals for `spikes/**`. `npm run verify` exit 0, `npm run build` exit 0, suite unchanged.
  (Worker — pushed, NOT merged. Spike only: nothing to integrate, a decision to take.)
- 2026-08-15 worker: `feat/hybrid-search` 🚧 PUSHED — **the MCTS NO-GO is reversed, and the reversal is
  measured.** Phases 1–4 of `docs/plans/superhuman-ai-program.md` §58. `packages/ai` only, plus DESIGN §3.4a.
  👉 **HYBRID beats the heuristic 60.0% over 120 seeded games, 95% CI [51.1%, 68.3%]** on Mono-Red Aggro
  vs Boros Aggro — seat AND play rotated, the *identical* protocol that measured vanilla MCTS at **40.8%
  [32.5%, 49.8%]**. Both intervals exclude 50%, in opposite directions. `DEFAULT_PILOT_ID` is untouched.
  ⚠️ **BUT A SECOND MATCHUP IS INCONCLUSIVE AND YOU SHOULD QUOTE BOTH.** UW Control vs Golgari Midrange,
  n=80: **53.8%, 95% CI [42.9%, 64.3%]** — the interval INCLUDES 50%. The point estimate still favours the
  hybrid, but on grindy boards the win is not proven. The honest one-liner is *significantly stronger on
  fast tactical boards, unproven on slow ones*. Anyone quoting only the 60% is overclaiming.
  ⚠️ **Decision cost is BOARD-SIZE dependent, not a constant:** 7.07 ms mean / 66 ms p95 on aggro boards,
  27.7 ms / 155 ms p95 on control boards, because the policy scores every castable card and plans its
  funding at every node. Budget accordingly.
  👉 **IT SCALES, which is the property that makes it a search rather than a constant.** Same matchup,
  same seeded games, only the budget varied: **16 sims → 48.3%** [39.6, 57.2] · **64 → 53.3%** [44.4, 62.0]
  · **256 → 60.0%** [51.1, 68.3] (all n=120) · **1024 → 61.7%** [49.0, 72.9] (n=60). Monotone throughout.
  That the tiny budget lands at ~50% is the right sanity check, not a failure: with almost no search a
  policy-guided search should reproduce its own policy, and it does.
  ⚠️ **IT ALSO PLATEAUS, AND THAT IS THE MORE ACTIONABLE HALF.** 16→256 buys **+11.7 points** for 16× the
  compute; 256→1024 buys **+1.7** for another 4× (and 88 ms/decision, p95 791 ms). Past a few hundred
  simulations the binding constraint stops being search depth and becomes **evaluator accuracy** — the
  search converges on the best line *its evaluation function can see*. **So do not spend the next branch
  raising the budget.** The next real gain is brief §11–12 (a tactical solver for lethal / anti-lethal /
  combat) and §31 (a learned value function).
  👉 **METHODOLOGICAL FINDING FOR THE LAB.** Running the gauntlet with `--pilot hybrid` on BOTH seats moved
  Mono-Red Aggro from **32.9% → 19.0%**. That is not a bug: when both sides play better, aggro's edge
  shrinks because much of it was punishing weak blocking. **Deck verdicts are pilot-relative** — an A/B
  swap answers "is this card better *at this level of play*". Worth stating in the Lab UI at some point.
  ⚠️ **The old NO-GO was correct about naive MCTS and wrong as a verdict on search.** Do not cite it as
  "search doesn't work here". What was broken was the QUESTION: the search's action space.
  👉 **PHASE 1 FIRST, and the numbers redirected the plan** (`bench/mcts-bench.mjs instrument`, and the
  search now reports its own shape through the optional `SearchStatsSink` — zero cost when absent):
  root branching mean **4.8** / max **9** (branching was never the problem); **105.8 engine plies per
  simulation of which 100.8 are ROLLOUT** — 95% of all work; only **25% of rollouts reach a terminal**, so
  three-quarters pay 100 plies and then fall back on a positional guess anyway; cost **linear** in rollout
  depth (0.75 MB/decision at 1 → 18.9 MB at 120); **41.6%** of offered actions are strategically duplicate
  (42,806 → 25,015 over 20 real games); **25.7%** of decisions have a single legal action.
  👉 **THE FIX IS STRUCTURAL, NOT A TUNING.** A search candidate is now an ATOMIC funded play — the taps
  *and* the cast, planned through core's `planManaPayment` (the same planner the heuristic pays with). A
  naked `tapForMana` is **not in the search space at all**, so the recorded tap-and-don't-spend failure has
  no representation to express. `MctsConfig.evalWastedManaPenalty` priced that symptom and cost 11.6 points
  of win rate; removing the representation costs nothing and gains 19.
  ⚠️ **Atomicity inside the tree is only HALF the fix and this trap is easy to miss.** The engine still
  asks one action at a time, so a pilot that re-searched after each tap could pick a *different* macro next
  time and strand the mana it just made — the same bug, re-entering through the front door. The pilot
  therefore COMMITS to its chosen macro and carries it out, re-validating every ply against the live legal
  actions (and turn/step/priority) before playing it, so a stale plan can never be forced through. It is
  also a ~4× speedup: a three-mana spell costs one search instead of four.
  👉 **NEW SEAMS other agents can use** (all additive, `packages/ai`): `policyCandidates(view, legal,
  weights)` — the heuristic's own scoring exposed as candidate STRATEGIC actions, which is the reusable
  form of "the heuristic knows MTG things the search doesn't"; `StateEvaluator` = `evaluateState` /
  `evaluatePolicy` (brief §30), heuristic-backed today so a learned model is a different ARGUMENT, not a
  different search; `actionEquivalenceKey` / `countEquivalentActions`, which both MEASURE redundancy and
  REMOVE it, so a claimed saving can't be fiction; `SearchStatsSink` for any future search.
  ⚠️ **TWO BUDGET POLICIES, DELIBERATELY NOT UNIFIED — do not "simplify" this.** `SearchBudget` is a
  discriminated union: `simulations` (deterministic, the ONLY kind the Lab's evaluation path may use) and
  `millis` (`PLAY_HYBRID_CONFIG`, interactive play only). A wall-clock budget makes the search
  machine-dependent, so the base and variant arms of a paired A/B swap can get DIFFERENT budgets on the
  same seed and the common-random-numbers premise dies. Making the kind explicit means nobody can become
  time-based by accident. Pinned by a test, including one that freezes `performance.now` and asserts the
  default budget's answer is unchanged.
  👉 **The evaluator is deliberately NOT "life + card count"** (brief §9): life, board stats, body count,
  card advantage, mana development, untapped mana, and a lethal-board bonus, each a named tunable weight.
  Regression tests pin the three blind spots the old life-and-board leaf eval had.
  ⚠️ **RULE 7 — heuristic path is UNCHANGED, proven two ways.** (1) BEHAVIOUR: `npm run sim -- gauntlet
  "Mono-Red Aggro" --games 40 --seed 99` is **byte-identical** between `main` and this branch on every line
  except the throughput line — same games, same winners, same counts. (2) THROUGHPUT, **interleaved** over
  7 alternating rounds of a 700-game gauntlet (sequential comparisons on this box have already "proved" a
  change free that a proper interleaved run showed cost 4%): **main median 109 games/sec, branch median
  118** — at parity or better, and main's spread (57..137) shows why only the median is quotable. The only
  heuristic edit was extracting `scoredSpellGoals` out of `bestSpellGoal` (same code, same order);
  everything else is new files the heuristic never calls.
  ⚠️ **I found and fixed a real measurement bug in the existing bench.** `wilsonInterval(successes, n)` —
  `z` is a REQUIRED third argument, so the `strength` mode has been printing `95%CI=[NaN%, NaN%]` all
  along. It now reads `DEFAULT_STATS_CONFIG.z`. If you have an old strength result with NaN bounds, that
  is why.
  ❌ **What I did NOT build, and why** — brief §11 tactical solver, §12 opponent-threat search, §13–17
  belief model / determinization, §18–22 transposition tables and tree reuse, §31 learned policy. The brief
  itself says do not build it all at once, and each of those is a branch. The measured order still holds:
  the next-largest win is tree reuse between decisions, because the pilot currently throws its tree away
  after every macro. ⚠️ Also NOT done: re-defaulting. The hybrid is ~1400× the heuristic's per-decision
  cost, so the Lab's stock gauntlet would go from seconds to hours; that needs a throughput case, not a
  head-to-head win. The previous `mcts` flip shipped on exactly that reasoning gap.
  ⛔ **`packages/core` untouched, but ONE change is wanted there** (reported, not made — core is hot-path
  and other branches are live in it): `planManaPayment` re-scans `view.battlefield` with a `.find()` per
  offered `tapForMana` action, i.e. O(sources × battlefield) per call, and the hybrid calls it once per
  castable card per node. An index built once per call would make it O(sources + battlefield). It is the
  single hottest thing the new policy does.

- 2026-08-15 worker: `feat/attachments` 🚧 PUSHED — **auras + equipment, as ONE seam.** Suite **1856
  passed / 0 failed** (baseline 1822 + 34), `npm run verify` exit 0, `npm run build` exit 0, lint 0 errors.
  👉 **The seam is a RELATIONSHIP, not two systems.** `CardInstance.attachedTo` + a data
  `CardDefinition.attachment` (host filter, `PermanentModification`, `whenIllegal`). An Aura and an
  Equipment differ in exactly two places, both DATA: how they attach (a spell script vs an `Equip {N}`
  activated ability — both the same `attachToTarget` primitive) and what the SBAs do when they are not
  legally attached (CR 704.5m to the graveyard / 704.5n just unattach). Core never asks "is this an aura".
  👉 **The buff is DERIVED, never stored** — the same choice `statics.ts` made, and it pays off the same
  way: an attachment's grant is re-read from `state.battlefield` on every effective-P/T read, so it
  vanishes the instant the attachment leaves play with zero bookkeeping. It folds into `indexContinuous`
  as layer 3a beside statics (3b), so attachments, anthems, +1/+1 counters and until-EOT pumps all stack
  additively through ONE path. A 2/2 with a counter, an anthem, an Equipment and a pump reads 9/8.
  👉 **`isLegallyAttached` is one predicate covering all three SBA cases** (host left play / host no
  longer matches the printed line / attached to nothing), and `attachTo` asks the SAME function before
  forming a relationship — so the engine cannot create a board the SBAs immediately undo.
  ⚠️ **The brief asked for "hexproof gained after attaching → aura falls off". That is NOT the rule and
  I did not implement it.** Hexproof/shroud stop a permanent being TARGETED (a cast-time rule); only
  PROTECTION makes an already-attached Aura illegal (CR 704.5m + 303.4c), and this engine has no
  protection. Dropping the Aura there would make every Aura strictly worse than printed. There is a test
  pinning the correct behaviour so nobody "fixes" it.
  👉 **New core API:** `TargetRestriction` gained `'creatureYouControl'` (what every printed Equip aims
  at — offering the whole table would let a pilot equip the opponent's board); `restrictionOfEffects` is
  now exported from the core index; `StaticAbility` now extends a shared `PermanentModification` and
  `staticIsInert` is a thin wrapper over `modificationIsInert` (no behaviour change).
  ⚠️ **`CardInstance.attachedTo` is OPTIONAL in the type and always WRITTEN by every mint/clone path.**
  Deliberate: gameplay instances keep one object shape, while hand-built literals in other packages'
  tests (apps/web has four) and any older serialized state still compile and read as unattached. Every
  reader tests `!= null`, never `!== null`. Making it required broke the apps/web build; making it
  optional touches nothing outside my packages.
  ⚠️ **I touched ONE line outside my packages: `packages/sim/src/paired-arms-config.ts`** adds
  `'attachToTarget'` to `LIBRARY_SAFE_PRIMITIVES`. Its own test asserts the two sets cover the whole
  registry, so ANY new primitive fails the sim suite until it is classified — this is that test doing its
  job, not a scope grab. Integrator: expect a trivial conflict there if another branch adds a primitive.
  👉 **Cards ship through the IMPORTER, not the pool, and that was forced.** `packages/data-tools/data/
  card-index.json` (156 cards) contains **zero** Auras and **zero** Equipment, and
  `apps/web/src/data/card-index.test.ts` requires every pool card to have a display row with art. So a
  curated-pool playset needs a Scryfall re-fetch (data-tools) plus a web index regeneration — both
  outside this branch. Verified faithful from real printed Oracle text instead: **Unholy Strength, Dead
  Weight, Flight, Bonesplitter, Loxodon Warhammer**. Anyone importing those today gets a real card.
  👉 **The pilot genuinely plays them, proven by BEHAVIOUR not by tests passing**
  (`packages/cards/src/attachments-play.test.ts` plays real games): an Aura lands on the pilot's OWN
  creature and its power really goes up; Dead Weight is aimed at the OPPONENT and kills the creature; the
  Equip ability is activated and the sword ends up attached. ⚠️ **The first version of the equip pilot
  looked perfect and equipped exactly never**: the engine only OFFERS an activated ability whose mana
  cost the floating pool already covers, and the pilot never floats mana speculatively, so reading
  `legalActions` found nothing. It now plans equip through the same `planManaPayment` a spell uses.
  Anyone wiring a future mana-costed ability into a pilot will hit this.
  ⚠️ **PERF (rule 7) — read this before you re-measure anything on this box.** Two measurements, and
  they DISAGREE, so both are reported:
  · **`packages/core/bench/engine-alloc-bench.ts` (the repo's own noise-immune measure — its header says
    wall clock here "is close to worthless"): PARITY or better.** 10.71 µs/action vs base 10.92;
    122.6 vs 120.2 games/sec; `cloneState` 4156 ns vs 4128 (34.6 vs 34.4 ns per cloned instance).
  · **Gauntlet wall clock: −3.6%, consistent.** Golgari Midrange, 300 games/opponent (2,100 games),
    seed 99, INTERLEAVED base/branch four times: branch 240/239/238/235 vs base 244/248/247/249.
    The games are **byte-identical** (`sim gauntlet` output diffs clean), so it is pure overhead, not
    different play.
  👉 **I could not attribute the 3.6% to any single change, and the bisect is recorded so nobody repeats
  it.** Reverting each of these individually recovered NOTHING beyond noise: `packages/core` entirely
  (core alone measures at parity), `targeting.ts`, the attachment SBA scan, the pilot's equip scan,
  `pool.ts`. It is diffuse — six one-comparison additions spread across `indexContinuous`,
  `checkStateBasedActions`, `isLegalTarget`/`legalTargetsFor`, the clone and the pilot.
  👉 **The remaining lever, if the integrator wants it:** a monotone `GameState.hasAttachment` flag set
  on battlefield entry, so a game whose decks contain no Aura or Equipment skips the attachment work
  entirely. I did NOT do it: it is a second structure that can desync from the truth (miss one entry
  path and an unattached Aura silently stops dying), and I was not willing to take that trade at the end
  of a session for ~1% on a benchmark whose noise floor is ±2.5%.
  ⚠️ **Measurement discipline:** this box drifts 332→346 games/sec on IDENTICAL code within minutes
  (thermal), and my first three comparisons were sequential and therefore worthless — one of them
  "proved" a change was free that a proper interleaved run later showed cost 4%. Alternate the variants
  inside one shell invocation, use ≥2,000 games, and prefer the allocation bench.
  👉 **Two real hot-path traps found and avoided, both worth knowing:** a helper returning
  `{ statics, attachments }` allocated an object on EVERY `indexContinuous` call (it runs several times
  per action) — the discovery is inlined instead; and the attachment SBA originally re-walked the
  battlefield once per FIXPOINT PASS — nothing enters the battlefield during SBAs, so the set is
  collected once per call and is `null` (one reference compare per pass) on every board without an
  attachment.
  👉 **Stale-hint fix:** the compiler's unsupported hint for `equip|attach|enchant` no longer says the
  whole system is missing; it now names the missing TEMPLATE. Separately: **`statics.ts` exists in core
  but NO compile rule reaches it**, so anthems still cannot be imported — that is a genuine gap and I
  left it alone because `feat/static-effects` is in flight on the same files.
  (Worker — pushed, NOT merged.)

- 2026-08-15 integrator: **`npm run lint` had been red on `main` for a long time — 259 errors — and
  nobody noticed because nothing ran it.** Now green (0 errors) and wired into a new root
  **`npm run verify`** (offline: lint + card-index `--check` + full tests). Run it before you push.
  What the 259 were: **226 were `dist-bundle/`**, i.e. eslint was linting the bundler's OUTPUT — now
  ignored. 29 were `packages/ai/bench/*.mjs` missing Node globals — `bench/` and `spikes/` now get the
  same globals block as `scripts/`. That left **4 real ones**, and they were worth having:
  👉 **`eslint-plugin-react-hooks` was never installed**, yet three files carried
  `eslint-disable-next-line react-hooks/exhaustive-deps`. Each disable was suppressing NOTHING and was
  itself an error (eslint rejects a disable for an unknown rule). Plugin installed; the classic pair
  (`rules-of-hooks`, `exhaustive-deps`) are ERRORS.
  👉 It immediately found a **real bug** in `components/match/useReplayPlayback.ts`: the auto-advance
  effect omitted `advance` from its deps, so the running interval held the closure from the render that
  started playback — **toggling "skip quiet frames" mid-playback silently did nothing** until you
  paused. The comment directly above it claimed the opposite. Fixed.
  👉 Two `useMemo`s flagged as having an "unnecessary" dependency (`importedCount`, `decks.decks`) are
  the opposite — **invisible** dependencies. `allAvailableCards()` reads a module registry that deck
  import mutates, so those deps are the only signal the pool grew; removing them (as the rule advises)
  breaks imported-card browsing. Documented disables, not removals. **Don't "fix" them.**
  👉 The compiler-era rules (`set-state-in-effect`, `refs`) are **WARN on purpose** — 5 sync setStates
  in effects + 1 ref-write during render, all in UI that currently works. Fix one file at a time and
  promote to error; a blind mechanical sweep is how working screens break.
  ⚠️ **Gap needing an owner: the web app has NO hook/component test infrastructure** — no
  `@testing-library/react`, no jsdom, zero `renderHook` anywhere. The replay bug above could only be
  guarded by the lint rule, not a test. Adding that stack is a real decision, not a drive-by; whoever
  takes it should propose it rather than sneak it into another branch.

- 2026-08-15 worker: `feat/card-index-truth` 🚧 PUSHED (apps/web/src/data + apps/web/scripts + the two
  web card doc-comments + one eslint global). **The reported bug did not exist — read this before
  anyone re-opens it.** The claim was that `apps/web/src/data/card-index.json` is a stale hand-copied
  32-card subset of a ~157-card pool. MEASURED on `ae1a894`: the web copy was **156 cards and
  BYTE-IDENTICAL** (sha1 `c94efd7e…`) to `packages/data-tools/data/card-index.json`, `CARD_POOL` is
  **156** (32 curated + 124 expanded), and the join is exact — **0** pool cards missing a row, **0**
  orphan rows, **0** rows without art. `c09b3ac` fixed it back in June.
  👉 **The "32" was STALE PROSE, and it cost a whole agent-task.** Three comments still described the
  pre-`c09b3ac` world — `lib/cards.ts` ("32 real MTG cards"), `lib/cards/enginePool.ts` ("only ~32 of
  them", "100+ cards … were invisible"), and `views/LabView.tsx` ("the curated index (~32)"). Someone
  read those, believed them over the data, and filed a headline defect. I corrected the first two;
  **`LabView.tsx:209` still says `~32` and I deliberately left it alone** because
  `feat/pool-adaptive-wire` owns that file — whoever merges that branch should fix the number.
  Treat a stale comment as a bug with a blast radius, not as decoration.
  👉 What WAS real: the copy was **unguarded**. Nothing generated it and nothing compared it, so the
  only thing preventing the reported bug was someone remembering to copy a file. It is now DERIVED by
  `apps/web/scripts/build-card-index.mjs` (`npm run cards:index -w @jonny-boi/web`, `--check` for CI)
  and `apps/web/src/data/card-index.test.ts` re-derives it every `npm test`. Sabotage-tested: cutting
  the file back to 32 cards makes 3 tests fail and names all 124 lost cards.
  👉 **The bundled index is now a PROJECTION, and that is a free PWA win.** Scryfall ships 11 image
  variants per card; `cardImage()` can only ever return 4 (`small`/`normal`/`large`/`art_crop`), so the
  other 7 were dead weight in every download. Dropping them: main chunk **758.58 → 642.14 kB raw
  (−15.4%)**, **179.11 → 170.65 kB gzip (−4.7%)**, PWA precache **958.80 → 845.09 KiB (−11.9%)**. A test
  asserts `DISPLAYED_IMAGE_VARIANTS` still covers every size `cardImage` can return, so widening the UI
  fails loudly here instead of quietly losing art.
  👉 **`enginePool.ts` now contributes ZERO records and should NOT be deleted for it.** It synthesizes a
  text-only display record for any engine card the index lacks; the index covers everything today, so it
  is an empty safety net — which is the healthy state, and the rule-6 fallback for the window between
  adding a card and regenerating. Comment updated to say so.
  ⚠️ **Two gotchas for the next person.** (1) `core.autocrlf=true` and there is no `.gitattributes`, so
  every committed JSON is CRLF on disk and LF in git — any byte-compare guard MUST normalize newlines or
  it reports a false "stale" on every Windows checkout. (2) The Scryfall CDN answers **HTTP 400 to
  `HEAD`**; art-liveness checks must use GET (I used a 1 KB Range + JPEG magic-number check). 28/28 real
  image fetches across 7 sampled cards incl. the one DFC came back as valid JPEGs.
  ❗ **`npm run verify` does not exist at the root** — I was told to extend it. The only `verify` in the
  monorepo is `@jonny-boi/data-tools`' NETWORK re-fetch against live Scryfall, whose own header says it
  must not run in `npm test` or CI. So the offline guard went where this repo's guards actually live
  (the vitest suite), plus a `--check` flag on the same module for a human/CI to call. If the integrator
  wants a root `verify`, `node apps/web/scripts/build-card-index.mjs --check` is the line to add.
  Suite **1822 passed / 0 failed** (baseline 1814 + 8 new), `npm run build` exit 0, eslint clean.
  (Worker — pushed, NOT merged.)

- 2026-08-15 DESKTOP-90PJPM4: **`feat/mechanics-wave2` MERGED to main + deployed.** main = **1735
  tests, build exit 0**. Adds **flash, hexproof, shroud** — three keywords that change what is
  LEGAL rather than what happens in combat, so each is read by the rule that governs it:
  - `flash` → `castTiming` returns 'instant'. Every consumer (legality, both pilots, hotseat UI)
    inherits it with no further change. An explicit `timing` on the card still wins.
  - `hexproof`/`shroud` → enforced in `isLegalTarget` AHEAD of any restriction, so they hold for
    every targeting effect rather than each one remembering. `legalTargetsFor` filters them out
    too, so a protected permanent is never even offered.
  ⚠️ **Perf note for anyone touching `isLegalTarget`:** it runs for every candidate target of every
  castable spell on the hot path, and reading GRANTED keywords needs `indexContinuous`. It now
  short-circuits on `state.continuous.length === 0` and printed keywords first; keep that ordering
  or the sim slows measurably.
  👉 Hint accuracy again: bare "flash" no longer routes to the queue (only `flashback` does), and
  the old hexproof hint now names only **ward and protection-from**, which really are missing.
  ⛔ **`gaining control` was attempted and deliberately BACKED OUT.** Doing it properly needs an
  `effectiveController()` threaded through combat, priority, and legality — `permanent.controller`
  is read directly in many places, and a continuous "control-change" layer without that accessor
  would be half-applied and silently wrong. It needs its own branch, not a corner of this one.
  STILL MISSING: planeswalkers, transform/DFC, {X} and derived values, alternative costs
  (suspend/spectacle/flashback/kicker), auras + equipment, ward/protection, gaining control,
  dynamic P/T, "unless its controller pays", targets chosen by a triggered ability.
  (Integrator)
- 2026-08-15 worker: `feat/pool-adaptive-wire` 🚧 PUSHED (apps/web + packages/sim) — **joins the
  multi-core worker pool to the adaptive suggestion search**, which had collided: the pool was still
  running the OLD fixed candidate loop, hand-rolled next to the sim, so the Lab ran the wrong algorithm
  fast and `determinism.test.ts`'s parity assertion against `suggestSwaps` failed (correctly).
  Successive halving is **stateful across candidates**, so the pool now dispatches ROUND BY ROUND with a
  barrier: shared base games for the round's new slots → join → every surviving arm's variant games,
  cut by SLOT range → join → the sim decides eliminations. The web layer schedules and decides nothing;
  verdicts, futility, the rank cut, Holm and the ranking all run through the sim.
  👉 **NEW SIM API other agents can use** (all additive): `RunOptions.range` — play a slice of the
  (opponent, game) grid on `runMatchup`/`evaluateSwap`, which is how a shard reuses those loops instead
  of copying them; `PairedArmRunner.playSlice` / `baseRecordAt` + `PairedArmsOptions.baseRecords` —
  play one arm's slots anywhere and adopt base games another process played; `prepareSuggestionRun` +
  `driveAdaptiveSearch` (a GENERATOR) + `finishSuggestionRun` — the search separated from whoever plays
  the games; `candidateSeedSalt`, `copiesSwappedBy`, `GAMES_PER_PAIRED_GAME` exported.
  `suggest.ts` was split into `suggest-candidates` / `suggest-run` / `suggest-report`; `suggestSwaps` is
  now just the single-threaded driver of the generator. **Two real bugs fixed in passing:** the adaptive
  engine reported `copiesSwapped: 1` for every suggestion under the default `playset` scope (so the
  Lab's Apply button offered to move one copy of a 4-of), and the CLI's `--pilot` help described the
  default as the look-ahead pilot when `DEFAULT_PILOT_ID` is `heuristic`.
  **MEASURED** (Mono-Red Aggro vs the 7-deck gauntlet, 24 candidates, seed 0xDEADBEEF, 12 logical cores
  that thermally throttle 3301→2011 MHz under all-core load):
    · pooled + FIXED (the pre-merge collided state, measured on a worktree at `a97b43f`):
      20,160 games, **28.5 s**
    · headless adaptive (CLI, one core): 2,438 games, **8.6 s** eval / 13.3 s wall
    · pooled + adaptive (this branch, 11 workers): 2,438 games, **4.5–5.0 s** → **~6× vs the
      collided state**, and byte-identical output to the CLI
    · at 200 games/finalist: 8,250 games in 9.6 s at 11 workers (867 games/sec) vs 41 s at 1 worker
      (206 games/sec) = **4.2× parallel**, i.e. 63% of the ~6.7× this box can actually reach all-core.
  **HONEST GAP:** the fixed sweep parallelises BETTER (708 games/sec vs ~870 here is close, but the
  fixed run is one flat queue with zero barriers). Round 1 is the weakest round (37% efficiency), not
  the late ones — splitting each arm's SLOTS keeps a two-survivor final round at 34 shards in flight.
  👉 **FOLLOW-UP worth someone's time:** ~1.9 s of a short run is 11 workers each independently building
  a card pool + effect registry. `SimWorkerPool.warmUp()` now overlaps that with the planning phase
  (round 1: 1.98 s → 1.08 s) but does not remove it — it is memory-bandwidth bound. A shared/immutable
  pool, or building it once and structured-cloning it, would be the real fix and would help every run
  kind, not just suggestions. (Worker — branch pushed, NOT merged.)

- 2026-08-15 DESKTOP-90PJPM4: **`feat/card-mechanics` MERGED to main + deployed.** It contained the
  whole stacked chain (`activated-abilities` → `conditional-taplands` → `card-mechanics`), so all
  three are now integrated — the table above is updated. main = **1648 tests, build exit 0**.
  Mechanics added across the chain: activated abilities with costs (fetchlands crack), conditional
  enters-tapped (fastlands/checklands), bounce, fight, mill, group damage, leaves-the-battlefield
  triggers, compound draw/lose, +1/+1 counters, artifact + opponent-only targeting, modal spells.
  👉 **THE "INVISIBLE PRIMITIVE" AUDIT IS WORTH RE-RUNNING PERIODICALLY.** Three separate mechanics
  turned out to be fully implemented primitives that NO compile rule could reach — `returnToHand`
  (bounce) and `modal` (every charm and command) among them. One line finds them:
  compare `CORE_PRIMITIVE_IDS` against the `primitive: '...'` ids the rule table emits.
  Only `createToken` and `tapPermanents` remain unreached.
  ⚠️ **Modal needed a TEXT change, not just a rule.** A modal card prints its header and each mode
  on separate lines, so the newline split handed the compiler "Choose one —" with no modes and then
  orphan bullets. `text.ts` now folds the block into one ability line. If you add a mechanic whose
  printed form spans lines, check `splitAbilities` first.
  ⚠️ Also note `'opponent'` targeting depends on WHO is casting, so `isLegalTarget` /
  `legalTargetsFor` / `illegalTargetReason` now take an optional `controller`. Absent ⇒ the target
  is ILLEGAL, never guessed.
  STILL MISSING (the honest remainder): planeswalkers, transform/DFC, {X} and derived values,
  alternative costs (suspend/spectacle/flashback/kicker), auras + equipment, hexproof/ward/
  protection, gaining control, dynamic P/T, flash + graveyard recasting, "unless its controller
  pays", and targets chosen by a triggered ability.
  (Integrator)

- 2026-08-15 DESKTOP-90PJPM4: `feat/card-mechanics` PUSHED (packages/cards + one core event).
  **1531 tests, build exit 0.** Stacks on `feat/conditional-taplands` → `feat/activated-abilities`;
  **merge that chain in order.** Four mechanics, each proven at BOTH levels (primitive behaviour +
  compiler reaching it from the real printed template):
  - **bounce** — `returnToHand` was already implemented and tested, and every bounce card was
    still reported unsupported, because no rule pattern could reach it. **Worth checking for more
    of these:** a primitive with no rule is invisible. Compare `CORE_PRIMITIVE_IDS` against the
    ids the rule table actually emits.
  - **fight** — reads BOTH powers before applying either, so a mutual kill kills both.
  - **mill** — moves cards through the owned-zone path so a milled card is really in the
    graveyard; short library empties rather than over-milling. Adds the `cardsMilled` event.
  - **group damage** — one `dealDamageToEach` for each-creature / each-opponent / symmetrical,
    snapshotting the battlefield first (damage is simultaneous).
  👉 **I also corrected the UNSUPPORTED HINTS, which feed UNSUPPORTED-MECHANICS.md.** Three now say
  "a <kind> template the compiler does not recognize yet" (the system exists; the printed shape is
  what is missing), and the bounce hint is DELETED — so "when ~ enters, return target creature to
  its owner's hand" now explains as **"targets chosen by a triggered ability"**, the real blocker.
  A stale hint sends the next agent to implement something that already works; treat the hint text
  as part of the feature, not decoration.
  ⚠️ **Machine was memory-starved** (~200-700 MB free, several agent sessions at once): `vitest`
  worker spawn failed repeatedly under Git-bash with `fork: Resource temporarily unavailable` /
  `spawn UNKNOWN`. Running the same command through **PowerShell** worked. Stop any dev server you
  are not using before a full-suite run.
  (Worker — pushed, NOT merged.)
- 2026-08-15 DESKTOP-90PJPM4: `fix/hero-validation` (apps/web only) — REPRODUCED LIVE, then pinned.
  Ran the dev server and imported a real Modern Boros list. The Match viewer answered:
  `unknown card "2588f348-…"` x4 and nothing else — four raw Scryfall uuids, shown nowhere else in
  the UI, so you cannot tell which of your cards is the problem. Cause: `validateHero` was copied
  into LabView and MatchView and the copies drifted; only the Lab's checked for unsupported imports,
  so the Match viewer fell through to the sim's id-level validator. Now one `lib/heroValidation.ts`
  (net -38/+8 in the views). Tests assert the NAMES appear and no uuid does, at the exact shape
  captured from the app (4 unplayable + 2 playable imports); removing the fix fails 3 of the 6.
  ⚠️ FOR WHOEVER OWNS `packages/cards/src/compile` (feat/card-mechanics): a split card is
  mis-diagnosed. "Wear // Tear" reports THREE bogus blockers — `“//” — needs the "//" card type`
  (the type line "Instant // Instant" is being split into a literal `//` type), and
  `“Wear // Tear” — needs transform / double-faced cards` (a split card is not a DFC; `layout` is
  `split`, not `transform`). Only `Fuse` and the targeting clause are real. Not fixed here: that
  package is yours and was uncommitted-dirty at the time. (Worker)

- 2026-08-15 DESKTOP-90PJPM4: `fix/hero-validation` ✅ (apps/web views + lib only) — **the Match viewer
  would not tell you which card broke your deck.** `validateHero` had been copied into BOTH `LabView`
  and `MatchView`, and the copies had drifted: the Lab's named unsupported imported cards first, the
  Match viewer's went straight to the sim's validator. So watching a game with a freshly imported deck
  failed as `unknown card "<uuid>"` — true and useless, and the uuid appears nowhere in the UI, so
  there was no way to work out which of your 60 cards it was.
  Fix: one shared `apps/web/src/lib/heroValidation.ts`, used by both views; the per-view copies are
  gone (DESIGN §1.3, one mechanism per concept). Behaviour is now identical on both surfaces, and an
  unsupported card is still reported FIRST — fixing a deck-size complaint would not make such a deck
  runnable. 5 tests in `heroValidation.test.ts` pin the ordering, the naming (asserts the uuid is NOT
  leaked), and that both surfaces refuse identically.
  Scope note: no `packages/**` touched. `deckHealth.ts` (used by DeckBuilderView) and
  `unsupportedCardNames` (used here) still answer overlapping questions — NOT merged, because that is
  a wider refactor across surfaces other agents are editing. Flagged, not started. (Worker)

- 2026-08-15 DESKTOP-90PJPM4: `feat/card-alacarte` ✅ MERGED to main + deployed. Add ONE Scryfall card
  by name from the card browser or mid-deck-build, fuzzy-matched ("lightnig bolt" resolves), screened
  by the SAME compiler deck import uses. New files only, no edits to the compiler — safe alongside
  in-flight `packages/cards/src/compile` work.
  👉 **NEW SEAM — `apps/web/src/lib/cards/unsupportedRegistry.ts`.** Every clause the compiler refuses
  is now COLLECTED, grouped by the missing engine SYSTEM (the unit of work — implement once, unblock
  every card waiting on it), with the blocked cards and a verbatim clause. Exports Markdown via
  `formatUnsupportedReport()`. **This is the queue to work from** — see the new
  [UNSUPPORTED-MECHANICS.md](UNSUPPORTED-MECHANICS.md) for the contract and how to pick an item up.
  👉 **NEW: [TESTING.md](TESTING.md)** indexes all 87 suites and what each guards, so there is one list
  to run through after a change. It also records the two lessons this repo learned painfully: test
  against the REAL vocabulary (the `destroy` vs `destroyTarget` fixture bug), and assert pilots play
  SENSIBLY, not merely that games finish (the MCTS-as-default bug).
  Also fixed: the card browser read the CURATED pool only, so an imported/added card never appeared
  in it at all — now reads the full pool and subscribes to the store.
  Deck-level honesty: `decklist/deckHealth.ts` badges any deck holding an unplayable card and names
  the cards; one unplayable card ⇒ whole deck unplayable (a blank card silently skews an A/B verdict).
  Suite **1460 passed / 0 failed**, build exit 0, Deploy PWA green.
  ⚠️ Verified by tests + typecheck + production build + a clean browser boot (no console errors); the
  add dialog was NOT driven interactively (the session's browser tooling was wedged), so the Scryfall
  round-trip is proven only against stub responses. Worth a real click-through.
- 2026-08-14 DESKTOP-90PJPM4: `feat/conditional-taplands` PUSHED (packages/core + cards/compile).
  Merged latest main (incl. the a-la-carte card adder) — **1489 tests, build exit 0**.
  Builds directly on `feat/activated-abilities`, so **merge that one first**.
  - `CardDefinition.entersTappedUnless` — a BOARD condition read as the permanent enters:
    `maxOtherLands` (fastland cycle) and `controlsSubtype` (checkland cycle, reusing the land
    subtypes added for fetchlands). The engine had only the unconditional "~ enters tapped", so
    every dual land whose drawback is a condition was unplayable.
  - ⚠️ **Self-exclusion is the subtle part.** Both battlefield-entry paths pass `self` so the
    entering land is not counted among "other lands you control". Without it every fastland enters
    tapped one land early — a silent one-turn tempo loss in every simulated game. Tested at the
    boundary (exactly the printed count, and one past it).
  - With no board supplied the answer is TAPPED: "enters tapped" is the printed rule and the
    "unless" is the exception, so the conservative answer can never make a card play better than
    printed.
  👉 **SHOCKLANDS ARE STILL UNSUPPORTED, on purpose.** "You may pay 2 life" is a price, not a board
  state, and it must be asked at LAND-PLAY time. The choice system cannot reach there: playing a
  land is a special action (`applyPlayLand`) and never opens a resolution frame, which is the only
  place `pendingChoice` can be parked. Whoever wants shocklands (a big slice of real manabases)
  needs choice-at-special-action first — that is the real prerequisite, not another compile rule.
  A test asserts Sacred Foundry stays reported so nobody "fixes" it by guessing.
  (Worker — pushed, NOT merged.)

- 2026-08-14 DESKTOP-90PJPM4: `feat/activated-abilities` PUSHED (packages/core + cards/compile +
  ai/heuristic). Merged latest main incl. `fix/rules-audit` — **1451 tests, build exit 0**.
  **Measured** on a real Modern Burn list through the importer: **19/60 playable → 30/60**, and the
  "library-search template" gap is gone. Fetchlands were 11 copies of dead card.
  - `CardDefinition.activated` — a `COST: EFFECT` line with {T} / pay N life / sacrifice ~ / mana.
    New `activateAbility` action. Offer and accept share ONE `unpayableActivationReason`, so a pilot
    is never handed an action the engine then rejects. Costs are paid in full before the ability hits
    the stack and are NOT refunded (rule 602.2). It rides the existing `trigger` stack object — no
    third stack-object kind for masking/replay/AI to learn.
  - **New seam worth knowing:** `CardDefinition.subtypes` (lowercased) + `CardFilter.anyOfSubtypes`.
    A fetchland searches for "a Mountain or Plains card" — that must find a SHOCKLAND, not just a
    basic, so matching by name would have been a card playing worse than printed. Any future
    subtype-selecting card gets this for free.
  - `targeting.ts` gained `illegalTargetReasonForEffects` / `restrictionOfEffects` so an ability is
    policed against ITS OWN effects rather than the card's spell script.
  - The pilot half matters as much as the engine half: an ability nothing activates is
    indistinguishable from a card that doesn't work. The heuristic cracks fetchlands and
    **deliberately nothing else** — a sac outlet or a pinger needs real cost/benefit reasoning and
    guessing would make pilots play worse. If you add ability scoring, that is the seam.
  👉 Next-biggest measured gaps on that same list, in copies: the unrecognised-template bucket
  (Eidolon's mana-value-filtered cast trigger, Searing Blaze, Skullcrack, Skewer's spectacle,
  Boros Charm's modes = 18 copies), then CONDITIONAL enters-tapped (Sacred Foundry / Inspiring
  Vantage = 8 copies; the unconditional form already works, these need the choice system for
  "unless you pay 2 life").
  (Worker — pushed, NOT merged.)
- 2026-08-15 DESKTOP-90PJPM4: `feat/card-alacarte` ✅ MERGED to main + deployed. Add ONE Scryfall card
  by name from the card browser or mid-deck-build, fuzzy-matched ("lightnig bolt" resolves), screened
  by the SAME compiler deck import uses. New files only, no edits to the compiler — safe alongside
  in-flight `packages/cards/src/compile` work.
  👉 **NEW SEAM — `apps/web/src/lib/cards/unsupportedRegistry.ts`.** Every clause the compiler refuses
  is now COLLECTED, grouped by the missing engine SYSTEM (the unit of work — implement once, unblock
  every card waiting on it), with the blocked cards and a verbatim clause. Exports Markdown via
  `formatUnsupportedReport()`. **This is the queue to work from** — see the new
  [UNSUPPORTED-MECHANICS.md](UNSUPPORTED-MECHANICS.md) for the contract and how to pick an item up.
  👉 **NEW: [TESTING.md](TESTING.md)** indexes all 87 suites and what each guards, so there is one list
  to run through after a change. It also records the two lessons this repo learned painfully: test
  against the REAL vocabulary (the `destroy` vs `destroyTarget` fixture bug), and assert pilots play
  SENSIBLY, not merely that games finish (the MCTS-as-default bug).
  Also fixed: the card browser read the CURATED pool only, so an imported/added card never appeared
  in it at all — now reads the full pool and subscribes to the store.
  Deck-level honesty: `decklist/deckHealth.ts` badges any deck holding an unplayable card and names
  the cards; one unplayable card ⇒ whole deck unplayable (a blank card silently skews an A/B verdict).
  Suite **1460 passed / 0 failed**, build exit 0, Deploy PWA green.
  ⚠️ Verified by tests + typecheck + production build + a clean browser boot (no console errors); the
  add dialog was NOT driven interactively (the session's browser tooling was wedged), so the Scryfall
  round-trip is proven only against stub responses. Worth a real click-through.

- 2026-08-14 DESKTOP-90PJPM4: `fix/rules-audit` — playtest sweep of the CLIENT layer. The headless
  engine is clean (new `packages/sim/src/rules-audit.test.ts` plays full games and asserts zone
  integrity, SBAs, untap, damage clearing, until-EOT expiry, land drops — 36 games, no violations).
  Every bug found was in the client:
  1. **Modal mana sources were dead in manual play.** `fix/ai-play-quality` moved Birds of Paradise to
     `producesOptions`, but four consumers still read `def.produces` directly (hotseat auto-tap,
     hotseat affordability, hotseat board view, online board view) and so saw it as producing NOTHING.
     My regression — apologies to anyone who played a Birds deck.
  2. **Hotseat auto-tap** had the pilots' old flaws: first-untapped-permanent, no colour reasoning, no
     summoning-sickness check, no stop condition.
  3. **Online play could never cast a spell.** The server only lists `castSpell` once the pool already
     pays, and the online board had no tap control at all. Now plans client-side and sends taps + cast;
     the server still validates every action.
  4. **Pass-and-play demanded a device handoff at every priority window** (~10/turn, nearly all empty).
     `hasMeaningfulChoice` / `autoAdvancePriority` skip windows offering only passing and unspendable
     mana taps, bounded by the existing `maxAutoAdvanceSteps`.
  5. Action bar sat below the fold at 720p — now sticky (`components/play/action-bar.css`, NOT styles.css).
  👉 **Seams other agents should know about:** the pilots' payment planner now lives in core as
  **`planManaPayment`** (+ `ManaTapPlan`), used by BOTH the AI heuristic and the client — do not add a
  third copy. It takes a narrow **`ManaPlanView`** (battlefield + pools) so the online client can plan
  from its redacted view; `legalTargets` was widened the same way. `canPay` remains the authority on
  payability, so the planner cannot disagree with the engine as costs grow.
  👉 **@engine-gaps agent:** I hit Kitchen Finks being castable off one land (`cost: { generic: 1 }`) and
  left it alone — your branch already fixes it with real hybrid costs. My planner defers to `canPay` and
  floors its distance heuristic at 1 pip precisely so hybrid symbols plan correctly when yours lands.
  Suite 589 passed / 0 failed at the time of writing, `npm run build` exit 0.
  ⚠️ **Merged latest main after the fact.** Main had meanwhile landed a MANUAL mana-tap menu
  (`lib/play/mana-tap.ts`) on both boards, which independently unblocks online casting — and does it
  better for modal sources, since it asks the player which colour rather than letting a planner pick.
  The two are complementary and both survive the merge: manual tapping for deliberate/floating mana,
  `castSequence` for one-click "tap and cast". If you ever need to choose, keep the manual menu.
  (Worker — pushed, NOT merged.)

- 2026-08-14 DESKTOP-90PJPM4: `fix/import-and-replay-visibility` PUSHED (apps/web + packages/ai +
  packages/sim test). Merged latest main (incl. the new core choice system) — **1099 tests, build exit
  0, suite now 61s**. Three user-reported bugs, all found by watching a game:
  1. **Import returned a crippled deck.** Unsupported cards were dropped silently with only a count.
     They now go IN the deck (a pasted list is a real deck); the honesty line moved to SIMULATION —
     no compiled definition ⇒ never in `importedDefinitions()` ⇒ can't reach a sim. The Lab refuses
     by NAME instead of `unknown card "<uuid>"`. Not-found names are listed too (usually typos).
     Also: `.import-dialog` had no max-height/overflow, so on a 60-card list the names rendered
     off-screen — that, not missing data, is why it "didn't tell you".
  2. **DEFAULT_PILOT_ID was MCTS and it plays badly.** Measured `manaPoolEmptied` (mana tapped and
     never spent): heuristic 0.01/turn vs **mcts 1.76/turn** — 176× — at ~100× the wall clock. That
     is the reported "tapped a Sol Ring and did nothing". Reverted to heuristic; MCTS stays
     selectable and earns the slot back on a measured head-to-head. New `pilot-quality.test.ts`
     guards waste rate + a hasty creature attacking an empty board — the suite previously asserted
     games FINISH and verdicts reproduce, never that pilots play SENSIBLY, which is how this shipped.
  3. **Watch a Game showed only counts.** Hand/library/graveyard are now expandable real card lists
     (library top-first, next draw labelled), the mana pool renders when non-empty, `manaPoolEmptied`
     prints a log line, and stepping fast-forwards to the next frame where something happened
     ("Skip quiet phases", on by default, reusing the log's own `describeEvent` filter).
  ⚠️ **DEV GOTCHA for everyone:** the web app resolves `@jonny-boi/*` to built `dist`, NOT src. A
  stale dist made the worker silently run the OLD pilot and the match viewer appeared to hang
  forever. Run `npm run build` after changing any package or the browser will lie to you.
  (Integrator)
- 2026-08-14 DESKTOP-90PJPM4: `feat/import-smart-names` ✅ (apps/web/src/lib/decklist only) — a standing
  regression guard on TWO REAL tournament lists (Boros Energy, Goryo's Vengeance) in
  `real-decklists.test.ts`. The unit tests prove each import rule alone; this proves they still compose
  on the lists that actually broke, offline, against a Scryfall fake that reproduces the one asymmetry
  that matters: `/cards/collection` matches a card FACE name only, while `/cards/search` also sees
  printed names. Covers "Wear // Tear", the Universes Beyond printing "Kavaero, Mind-Bitten"
  (Scryfall files it as "Superior Spider-Man"), and DFCs named by their front face.
  MEASURED against these lists on this commit: every name now resolves (0 not-found), but only
  **2/75 and 6/75 copies are PLAYABLE**. The wall is not import — it is compiler/engine coverage:
  • the biggest bucket is "a rules template the compiler does not recognize yet" (19 + 12 copies), and
    it is a LONG TAIL of unrelated mechanics (Ascend, Mobilize, Rebound, Replicate, Warp, cost
    reduction, counterspells, Blood Moon's static effect) — no single fix unlocks it.
  • the one COHESIVE win is the mana base: fetchlands + shocklands are 15 copies in EACH list (20% of
    the deck). ⚠️ Do not start that here — `feat/activated-abilities` is actively building it
    (`cost: { tap, life, sacrificeSelf }`, an `activateAbility` action, fetchland tests). Shocklands
    additionally need the "you may pay 2 life" choice, which `packages/core/src/card.ts` documents as
    deliberately unimplemented pending the choice system that branch also owns.
  No `packages/core` or `packages/cards` files touched, by design. (Worker)

- 2026-08-13 DESKTOP-90PJPM4: `feat/import-formats` ✅ (apps/web/src/lib/scryfall + decklist/resolve) —
  **two real deck-import bugs, found by importing the user's actual Modern lists.** The *parser* was
  never at fault: both a Boros Energy list and a Goryo's Vengeance list parsed 60 main + 15 sideboard
  with ZERO errors already. Both failures were in the Scryfall lookup:
  1. **`/cards/collection` matches a card FACE name, not the combined "A // B" name** that
     `/cards/named` accepts. Asking it for "Wear // Tear" is a miss; asking for "Wear" returns the
     whole card. Every split / DFC / adventure card written in full form silently vanished from an
     import. `collectionQueryName()` now queries the front face and maps the answer back, and misses
     are still reported under the wording the user typed.
  2. **Universes Beyond printings are filed under their licensed name.** "Kavaero, Mind-Bitten" is
     Scryfall's "Superior Spider-Man" with the Magic name in `printed_name`, which the collection
     endpoint cannot see. Added a second-chance pass: for names that missed, one
     `/cards/search?include_multilingual=true&q=!"…"` each. Anchored with the `!` exact operator on
     purpose — fuzzy matching would silently import the WRONG card for a typo, which is exactly the
     kind of quiet lie that poisons an A/B verdict. Costs zero requests on a list that resolves clean.
     `CollectionResult.aliases` ties the recovered card back to the line, since callers index by name.
  Result: both lists now resolve **75/75 cards, 0 not-found** (was 74/75 each).
  ⚠️ **Resolving is not playing.** Those same lists are 2/75 and 6/75 PLAYABLE — everything else is
  `blocked`, correctly, by compiler coverage. The top gaps by card count are the project's real
  to-do list: an unrecognised-template bucket (19 + 12), *player choice during resolution* (8 + 9),
  *permanents entering tapped* (3 + 7, i.e. shocklands), *library search with a chooser* (fetchlands),
  *sacrifice costs*, and *{X}/hybrid/Phyrexian costs*. Modern decks are unplayable here until those
  land; no amount of import work changes that. (Worker — branch pushed.)
- 2026-08-13 DESKTOP-90PJPM4: `feat/app-icon` ✅ (apps/web icons only) — replaced the "jb" placeholder
  with **AI-generated key art**: a phoenix erupting in fire inside a burning ring.
  **Use the `asset-tooling` repo for art, not hand-authored SVG** — a first attempt at hand-drawn vector
  marks was rejected by the user as not close to game-art quality, and it isn't. Art comes from
  Pollinations/FLUX using the same recipe as Treadlight's `tools/gen_icon.py` (prompt + seed recorded in
  `SOURCE_PROMPT` in the script, so it is reproducible). Generic dark fantasy only — no Wizards/Scryfall
  art as input or reference, no trademarked symbols.
  `apps/web/scripts/generate-icons.mjs` (`npm run icons -w @jonny-boi/web`) no longer *draws* anything: it
  derives all six outputs from one square `public/icons/source-art.png`, so **swapping the icon = drop in a
  new PNG + re-run**. `SMALL_CROP` controls how far small sizes punch in — keep it near 1 for art whose
  emblem already fills the frame (cropping the phoenix's ring leaves an unreadable blob); art with dead
  margin can crop harder. The maskable variant sits inside the 80% safe circle on a plate sampled from
  the art's own DARKEST corner — a blurred-copy backdrop was tried first and always left a rectangular
  seam, and averaging the corners picks up the emblem's glow and lands too light. Manifest/`index.html` are now PNG-only (the SVG icons are gone). Regenerating needs
  `npm i -D sharp`; deliberately not a repo dep since the outputs are committed. (Integrator)

- 2026-08-13 DESKTOP-90PJPM4: `fix/ai-play-quality` — **COMBAT COULD NOT END.** The reason MCTS games
  appeared to "take forever" was not search cost: `CombatState` inferred "have attackers/blockers been
  declared?" from whether the list was NON-EMPTY. But declaring *no* attackers (or no blockers) is a
  legal, routine choice, so an empty declaration left the step looking undeclared, it was offered again,
  and since declaring resets `consecutivePasses` **the step could never advance**. A pilot that passes by
  convention (heuristic) never hit it; a pilot that SEARCHES its options did — MCTS spun one
  declare-blockers step 240+ times and a game never got past turn 5 in 4000 actions.
  Fix: explicit `attackersDeclared` / `blockersDeclared` flags on `CombatState`, gated in both
  `applyDeclare*` and `generateLegalActions`. Anyone constructing a `CombatState` literal must set them
  (test fixtures updated). Regression covered in `packages/core/src/combat-declaration.test.ts`,
  including a full game of adversarial empty declarations that must still reach turn > 8.
  Perf, all strength-neutral (same search, same results — measured, not assumed):
  • `applyActionInPlace` — a no-clone entry point for look-ahead that already owns its state. The pure
    `applyAction` deep-copies BOTH libraries (100+ instances) per action; MCTS now clones once per
    playout instead of once per ply.
  • MCTS skips windows where the only options are mana taps and nothing in hand is castable — pools
    empty each step, so that mana is provably unspendable. Cut searched decisions 390 → 216.
  Net for one full game: **never terminated → 50s → 29s** (bench), and end-to-end **18.6 s/game**
  (10-game CLI match). Heuristic re-measured at **161 games/sec**, parity with its pre-change baseline.
  ⚠️ Still ~3000× the heuristic's cost: `--pilot heuristic` remains the right choice for bulk A/B runs,
  and it is now much stronger too (removal and combat tricks actually function — see the note below).
  (Worker — branch pushed.)

- 2026-08-12 DESKTOP-90PJPM4: `fix/ai-play-quality` 🚧 (packages/core + packages/ai + packages/sim/cli
  + apps/web match viewer). Four real bugs a user spotted while WATCHING a game, plus the AI upgrade:
  1. **Summoning sickness did not gate `{T}` abilities** (rule 302.6). A Birds of Paradise could tap for
     mana the turn it landed. `generateLegalActions` + `applyTapForMana` now check it (granted haste
     honoured via effective keywords, like the attack check).
  2. **`produces` meant "add one of EACH"**, so an any-colour source made FIVE mana. Added
     `CardDefinition.producesOptions` — a MODAL list where one tap yields ONE chosen mode — and
     `TapForManaAction.mode` to pick it. `manaModesOf()` normalises both forms into one mode list.
     **Legacy `produces` is untouched and still means the fixed bundle**, so Forest `['G']` and Sol Ring
     `['C','C']` stay correct and `packages/cards/src/compile/` keeps compiling unchanged.
     👉 **@deck-import/compiler agent:** your `HUMAN_APPROXIMATIONS` exemption for Birds
     (compile.test.ts) documents exactly this bug — core can now express it. Point the
     `tap-for-any-color` rule at `producesOptions: [{W:1},{U:1},{B:1},{R:1},{G:1}]` and drop the
     exemption when convenient. `tap-for-mana` ({T}: Add {C}{C}) needs no change.
  3. **The AI's primitive vocabulary was wrong**: it looked for `destroy`, but cards register
     `destroyTarget`/`exileTarget`, and it knew nothing of `pumpUntilEndOfTurn`. So ALL removal and every
     combat trick fell through to "generic spell", got cast with NO target, and silently no-opped. The
     AI's own fixtures used the same fake id, which is why the tests never caught it — fixtures now use
     the real registered ids.
  4. **Overtapping**: the pilot tapped the first untapped source with no colour reasoning and no stop
     condition. Replaced with `planManaTaps` (plans the exact taps, prefers the least-flexible source,
     stops when the cost is covered) and goals are now only pursued if they can actually be funded.
  Pump spells now have real scoring (save a creature / win a fight / push lethal) and MCTS enriches them
  with own-creature targets. ~~`DEFAULT_PILOT_ID` (packages/ai) is now `mcts`~~ — **REVERSED 2026-08-15.**
  `DEFAULT_PILOT_ID` is `heuristic`. MCTS was measured 2000× slower *and* significantly weaker (40.8% win
  rate over 120 seeded games, 95% CI [32.5%, 49.8%] — excludes 50%) against the very heuristic it uses as
  its rollout policy. See DESIGN.md §3.4 for the full numbers and the diagnosis. Do not re-default it.
  Perf (rule 7): measured heuristic at **162.7 games/sec vs 161.7 baseline** (parity) after memoizing
  `manaModesOf`/`bestManaYield` per definition and removing per-candidate pool allocations.
  New UI: `CardHover` (apps/web/src/components) raises a full readable card on hover in the replay board;
  its styles live in `card-hover.css`, NOT styles.css, to stay off the deck-import branch's toes.
  (Worker — branch pushed, NOT merged.)
- 2026-08-13 DESKTOP-90PJPM4: `feat/engine-gaps` PUSHED (branched off the deck-import commit, built in
  its OWN worktree so it never touched the uncommitted `fix/ai-play-quality` work in the main tree).
  Contains: (1) **hybrid mana costs** — `ManaCost.hybrid` + exhaustive payment search; Kitchen Finks now
  carries its real `{1}{G/W}{G/W}` instead of the `{1}` the pool was cheating with. (2) **entersTapped**
  on `CardDefinition`, honored on every battlefield-entry path (unconditional form only). (3) compiler
  rules for both. (4) **imported cards now reach the sim worker** (requests carry compiled definitions;
  injected at the single postMessage chokepoint) — imported decks are Lab-simulatable. (5) Proxies'
  duplicate Scryfall batching loop migrated onto the shared `lib/scryfall/collection.ts`. (6) **§3.12
  photo scanning** — photo of laid-out cards → decklist, fully on-device. 583 tests, build exit 0.
  👉 **@ai-play-quality agent:** thanks for the `producesOptions` note. I did NOT touch it — your branch
  still owns that. Once both land, the compiler follow-up you described is a small edit: add a
  `producesOptions` rule for "{T}: Add one mana of any color" / "Add {R} or {W}" and drop the
  `mana abilities that produce a chosen color` hint. Heads-up on the merge: we both edited
  `packages/core/src/card.ts` (you: `producesOptions`/`manaModesOf`; me: `entersTapped`) and
  `engine.ts` — additive in different regions, but expect a conflict marker or two. (Worker — branch
  pushed, NOT merged.)

- 2026-08-12 DESKTOP-90PJPM4: `feat/deck-import` — DECK IMPORT + ORACLE-TEXT COMPILER (DESIGN §3.11).
  Paste any decklist / deck URL / file → real cards. New `packages/cards/src/compile` turns printed
  Oracle text into genuine `CardDefinition`s from registered primitives, and REFUSES to approximate:
  a card is either fully implemented or reported with the exact clause + missing engine system.
  Compiled cards reach the engine via a new `loadCardPool({ extraCards })` seam. Suite = **535 tests,
  build exit 0**. Live-verified against real Scryfall: a Modern Burn list imported 27/58 playable, with
  Lava Spike → `{R}` sorcery/dealDamage 3 and Lightning Helix → `{R}{W}` instant/dealDamage 3+gainLife 3.
  **TWO REAL BUGS FOUND in existing data** (not introduced here, both flagged in DESIGN §3.11):
  (1) Birds of Paradise taps for FIVE mana — `produces` adds one of each listed color, so the authored
  five-color list is not "any color"; this biases every green-ramp sim today. (2) Kitchen Finks is
  authored as `{1}`, dropping its `{G/W}{G/W}` — a 3-mana 3/2 costing one. Fixing either needs an
  engine feature (chosen-color mana abilities; hybrid costs), so neither is patched here.
  FOLLOW-UP not done: the Lab's sim **Web Worker** builds its own pool and does not yet receive
  imported definitions, so imported decks build/play but are not yet simulatable in the Lab. Also
  `apps/web/src/lib/proxy/scryfall.ts` still has its own batching/throttle loop that should migrate to
  the shared `lib/scryfall/collection.ts`. (Integrator)

- 2026-06-26 DESKTOP-90PJPM4: `feat/proxy-print` 🚧 (apps/web) — porting the user's separate `mtg-proxy-man`
  tool (Python/PySide6/Scribus proxy-print pipeline: A4, exact card size, custom art, upscaling; the real
  version is LOCAL at C:\Users\Caleb\Documents\VS Code Projects\mtg-proxy-man, GitHub has only the art
  downloader) into jonny-boi as a "Proxies" tab: paste decklist → Scryfall png art → 63×88mm cut-to-size
  proxy sheets (A4/Letter, 3×3, cut guides) → browser Print/PDF. Makes jonny-boi a one-stop MTG shop.
  (Hosting decision HF-Spaces-vs-Cloudflare still OPEN — deferred by user.) (Integrator)

- 2026-06-22 DESKTOP-90PJPM4: ONLINE MULTIPLAYER server + client BOTH INTEGRATED. main = **384 tests,
  build exit 0**. LIVE-VERIFIED: started the server (`npm run server` → ws://localhost:8787) + web client,
  Play→Online→Create connected live and created Room GY5Z8 with the lobby (Seat A you / Seat B waiting).
  Server agent also proved a real two-client socket game to completion + masking (no hidden-card leak).
  LAUNCH FIX: the nested `npm run start --workspace` script got orphaned by the bg tool — root `server`
  script now `tsx apps/server/src/main.ts` (dedicated unconditional entry; index.ts is pure lib). To run a
  live server PERSISTENTLY across tool calls use `Start-Process node --import tsx apps/server/src/main.ts`
  detached (the run_in_background tool tears the server down). REMAINING for internet play: user runs the
  one-time host deploy (apps/server/DEPLOY.md → Render/Docker) + sets web build `VITE_SERVER_URL=wss://host`.
- 2026-06-22 DESKTOP-90PJPM4: ONLINE MULTIPLAYER underway (user: "hotseat now, online later" → now). New pkg
  `@jonny-boi/protocol` ✅ on main (client/server message contract + `maskStateForSeat` anti-cheat; 327 tests).
  Authoritative-server model (server runs the engine, sends each client only its masked view). Dispatched
  `feat/online-server` (apps/server: ws + rooms/lobby + masked relay + Render/Docker deploy prep) +
  `feat/online-client` (apps/web: Play→Online flow + ws client, renders the server's MaskedGameView, reuses
  hotseat board). Server defaults to PORT 8787; client dev default `ws://localhost:8787`, prod via
  VITE_SERVER_URL. NOTE: 3 agents rate-limited mid-task today (server-side); I authored protocol myself when
  its agent died instantly. Internet deploy needs the user's host account (one-time) — build runs LAN/local now.
  (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `hotseat-play` INTEGRATED — 2 humans play a full MTG game on ONE device
  (pass-and-play). New "Play" tab: setup → hand-hiding device handoff → mulligan → full game (lands, casts
  w/ targeting+auto-tap, combat declare/block, stack responses, win). Main = **321 tests, build exit 0**.
  Screenshot-verified (setup/handoff/mulligan render w/ real art) + headless full-game-to-winner test.
  `GameSession` is transport-agnostic; `seat.ts` SeatTransport seam → online play later = a transport swap
  (set localControls per-peer, drop the handoff), zero session/UI rewrite. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: Polish wave INTEGRATED — `meta-decks` (6 archetypes), `match-viewer`
  ("Watch a Game" replay), `mcts` (selectable pilot, full-fidelity rollouts; registry now threaded into the
  `match.ts` decision loop). Main = **314 tests, build exit 0**. NEW FEATURE dispatched: `feat/hotseat-play`
  — 2 humans play a real MTG game on one device (pass-and-play), architected so online sync can follow.
  Reuses the engine seam (generateLegalActions/applyAction) + cards registry directly in apps/web. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `web Lab` (§3.7) + `cards-v2` INTEGRATED. Main = **279 tests, build exit 0**.
  Lab = in-PWA gauntlet/A-B-swap/suggestions via a Web Worker (screenshot+run verified: real win-rates
  computed in-browser, 0 console errors). cards-v2 = real cards on engine-v2 (prowess/tokens/persist/pumps
  wear off) → verdicts now FAITHFUL (still-stubbed: transform/DFC, dynamic P/T, planeswalker loyalty, flash).
  Full vertical slice live at https://cjacobscoding.github.io/jonny-boi-app/. Dispatched `fix/fidelity-caveat`
  (stale "provisional" note). Match-viewer (replay) is the remaining §3.7 nice-to-have. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `engine v2` (§3.9) INTEGRATED — triggers + until-EOT continuous effects.
  Main = **254 tests, build exit 0**. Adversarial review caught + fixed a combat-bias bug (block/attack
  legality now reads continuous/granted keywords, matching the damage step). BREAKING: `StackObject` is now
  a union (`spell`|`trigger`); fixed `cards` counterSpell + its test to narrow on `kind`. Engine API for
  cards-v2: `CardDefinition.triggers` (etb/attacks/dies/leaves/castSpell/upkeep), `ctx.addContinuousEffect`,
  `ctx.createToken`, `effectivePower/Toughness/Keywords`. Dispatched `feat/cards-v2` to un-stub real cards +
  make pumps wear off. `feat/web-lab` (apps/web) still building. (Integrator)
- 2026-06-21 DESKTOP-90PJPM4: `suggestion engine` (§3.6) INTEGRATED — 233 tests. `suggestSwaps()` ranks
  candidate single-card swaps via the §3.5 paired test; CLI `npm run sim -- suggest <deck>`. Verified real
  significant rec: Mono-Red Aggro Lightning Bolt→Kitchen Finks = BETTER (+4.1%, p=0.002). Honest budget-cap
  coverage. `engine-v2` (§3.9) still building on feat/engine-v2-triggers. Next after it: cards-v2 (un-stub
  real cards onto triggers/EOT), then wire web Lab→sim (suggestSwaps report is UI-ready). (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `sim` (§3.5) + `web` (§3.7 foundation) INTEGRATED. Full main suite = **216
  tests, build exit 0**, and now runs from pure src with NO build-before-test (fixed root vitest.config to
  alias all packages → src). `npm run sim -- swap` gives real paired-McNemar verdicts (~210-260 games/sec);
  e.g. Mono-Red Aggro: Goblin Guide→Sol Ring = WORSE (-3.2%, p=0.003). Web = pro card browser + deck builder
  with real Scryfall art (PWA), screenshot-verified. §3.7 still 🚧 (lab/match-viewer/suggestions remain).
  NOTE for integrators: scope `dist` cleanup to package roots — a recursive `dist` delete nukes
  node_modules/*/dist (broke vite); `npm ci` repairs. Next: §3.9 engine v2, §3.6 suggestion engine, wire web→sim.
- 2026-06-20 DESKTOP-90PJPM4: `ai` (§3.4) INTEGRATED — full main suite = 165 tests, build exit 0. random +
  heuristic pilots (seeded, tunable `HeuristicWeights`). `sim` drives: `createDefaultAiRegistry()` →
  `getPilot(id)` → loop `generateLegalActions → chooseAction({view,legalActions,rng}) → applyAction`.
  FOUNDATION COMPLETE (engine+cards+ai+data-tools). Wave 3 = `feat/sim-harness` (§3.5) — the heart.
  (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `cards` (§3.2) INTEGRATED — 134 tests on main. All 32 staples load+play, ids
  joined to Scryfall by UUID. SURFACED ENGINE GAP: MVP core has no triggered-ability system, no
  until-EOT/continuous-effects layer, no planeswalker/transform/dynamic-P-T. Several meta cards stubbed;
  `pumpUntilEndOfTurn` doesn't wear off (sim-combat bias). New roadmap item §3.9 "Core engine v2" added —
  needed before meta-deck sims are trustworthy. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `core` (§3.1) INTEGRATED to main — 62 core tests (incl. adversarial-review
  fixes: blocked double-strikers no longer leak face damage; effect registry threaded explicitly, no
  module global). Full main suite = 102 tests green. Wave 2 dispatched: `feat/cards-pool` (§3.2) +
  `feat/ai-pilots` (§3.4), both build on core's seams (CardDefinition/EffectRegistry; generateLegalActions/
  applyAction), disjoint packages, parallel. `ai` tests against its own minimal fixtures (does NOT depend on
  `cards`) to stay parallel. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: `data-tools` (§3.3) INTEGRATED — 47 tests green, 32/32 starter cards resolved
  live from Scryfall, text card-index.json committed (image bytes gitignored). Card data now available to
  `cards`/`web` at `packages/data-tools/data/card-index.json`. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: Wave 1 dispatched — `feat/core-engine` (§3.1) + `feat/data-tools-scryfall`
  (§3.3) in parallel; disjoint packages, no cross-dependency. core blocks cards/ai/sim, so it's the
  keystone. data-tools is independent. (Supervisor/integrator)
- 2026-06-20 DESKTOP-90PJPM4: Scaffold (§3.0) INTEGRATED to main — `npm install/test/build` all green,
  PWA build emits sw.js + manifest. Other packages branch off `origin/main`. (Integrator)
- 2026-06-20 DESKTOP-90PJPM4: Repo seeded with rules + this board + DESIGN. Stack = TS npm-workspaces
  monorepo (core/cards/ai/sim/data-tools + apps/web PWA), Scryfall art, curated card pool. Node 24 LTS
  installed on this machine. Scaffold (§3.0) goes first and blocks all other work. (Supervisor)
