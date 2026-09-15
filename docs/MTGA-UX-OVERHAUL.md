# The MTGA-parity play-surface overhaul (§3.143)

> **Status: durable reference.** Raised by Caleb on **2026-09-11** as one request. This file is the
> single source of truth for the scope; DESIGN.md §3.143 tracks status, COORDINATION.md tracks who
> owns which lane. **Do not re-scope from memory — re-read this file.**

## 0. The request, verbatim

Preserved word-for-word so that no later summary can quietly drop a clause.

> please make the app more like MTGA when playing the game. The UX is so bad. I cant see whats on the
> stack at any given moment but I should be able to easily see cards on the stack - and not just card
> names - just like MTGA. Anytime I activate an ability or anything that targets cards, until Ive
> actually chosen the targets, I should be able to back out of the spell/ability as long as nothing
> has mutated game state yet. Since, in magic, you can think about casting a spell,
> consider/inspect the potential targets, then decide not to. Once you choose targets (or choose no
> targets) and confirm, at that point, the decision should be irreversible and show up on the stack
> (unless rules state otherwise). Also, I'm still getting a lot of situations where I invoked
> something that needs target's chosen but also says "may" - and in those cases, it's asking me for
> targets before it asks me if I actually want to do the thing. Thats backwards. It should be asking
> me if I want to, then asking me for targets IF and only if I say that I do want to. And even after
> I say yet to the MAY stage, if I change my mind when I see the target options, I should still be
> able to idempotently change my mind about casting the spell/activating the ability, ect - and at
> that point, the item should not have entered the stack anyways. Also, anytime a card is asking me
> to choose target(s), it should be showing the actual card(s) that is provoking the choice - not
> just the card name. Also, the battlefield arrangement currently is dismal. It should look like a
> battlefield when you are actually playing mtg in real life, more like how MTGA does it... With a
> 3d view looking down and slanted just a bit at the tabletop, from the perspective of the player -
> and hovering over any card ever should let you see a full clear view of the card, cards actually
> angled 90 degrees when tapped (including when attacking!), attacking creatures moved forward
> towards the player being attacked, but without crossing the midline between players, chosen
> blockers being moved forward to meet the creatures they are blocking, firey, cool looking arced
> arrows indicating block/attack pairs. Animations when block phase is over and damage is being
> distributed to players and creatures, just like MTGA does it, so you can clearly see what's
> happening... Also when an opponent casts a sorcery or instant card, I need to be able to see it
> and inspect the card before it goes off - even if I have no instant-speed things I could do in
> response - just so I can see what they are doing and understand! Right now, they just happen
> invisibly and I have no idea why things are happening. I also need any effects added to a card
> that they dont come printed with to be actually altered on the card image itself and made to look
> obviously after-market - like bolded, different color text, ect. For example, if a creature has an
> enchantment on it that gives it +1/+1 and flying, and its base power and toughness are 4/5, I want
> to see printed on the card on the battlefield an actual 5/6 instead of 4/5, but it should have a
> different visual treatment to show it has been altered from printed. And if I hover over that 5/6,
> it should show a full breakdown in a tooltip of what the base is and where the additional
> amount(s) came from. And the 'flying' ability it is getting from the enchantment should also be
> there visibly, in the rules text, just as if it was there natively - but with a different visual
> treatment. Like if the base creature already had "vigilance, first strike" in its rules text, it
> should now say "vigilance, first strike, flying" and hovering over the flying should explain where
> it came from since it is aftermarket. Also, hovering over any ability like "vigilance" for
> example, on any card, should show a tooltip explaining clearly what that ability does/how it
> works. In the case that something is actually removing an ability from a card, it should show it
> there but striked-through and hovering should given an explanation. The same support should be had
> for anything that mutates/adds to/removes anything on a card - whether its the card's type,
> subtype, name, anything that something could effect. This way players can clearly see what's
> happening.

## 1. The work items

Seventeen items in five lanes. **The lane is the collision boundary** (DESIGN §6 / CLAUDE.md rule 8):
an agent owns its lane's files and nothing else.

**Status column, audited 2026-09-11 (wave 3).** `✅` done · `◐` partial, with exactly what remains
named in §7.1 · `⏸` deferred with a reason. **`px` after a verdict means it was checked against a
REAL RENDERED SCREENSHOT**, not only against source; a verdict with no `px` is a source reading and
says nothing about whether a player can see the thing. That distinction is the whole lesson of this
branch — see §7.3.

| ID | Lane | Item | One-line acceptance | Status |
| --- | --- | --- | --- | --- |
| **UX-1** | A — Stack | Stack shows real card faces, not names | Every stack object renders its card image at a readable size, top-of-stack marked, hoverable to full-size | ✅ |
| **UX-2** | A — Stack | Stack is always visible when non-empty | No scroll, no panel hunt — the stack occupies a fixed, always-on-screen region during any priority window | ◐ |
| **UX-3** | B — Commit | Two-phase cast/activate: **propose → confirm** | From opening a cast to confirming targets, **zero** game-state mutation is visible; cancel restores byte-identical state | ✅ |
| **UX-4** | B — Commit | Cancel is idempotent and always available pre-commit | Escape / an explicit Cancel returns to the pre-proposal board from ANY pre-commit step, repeatedly, with no side effects | ✅ px |
| **UX-5** | B — Commit | Post-commit is irreversible and lands on the stack | Once confirmed, the object appears on the stack; no cancel affordance is offered (unless the rules genuinely allow one) | ✅ |
| **UX-6** | C — Prompts | "May" is asked **before** targets — for the whole CLASS | A **closed table** of optional-gate shapes; asked for triggers, activated abilities, spells, replacements alike — not just `def.triggers` | ✅ |
| **UX-7** | C — Prompts | Saying yes to a "may" is still reversible until commit | Answering the may and then backing out at the target step leaves nothing on the stack | ✅ |
| **UX-8** | C — Prompts | Every target prompt shows the **source card's face** | The card provoking the choice renders as an image, not a name string; candidates render as card faces too | ✅ px |
| **UX-9** | D — Board | 3D tabletop: perspective, tilted, from the player's seat | A real CSS 3D scene with a named, tunable perspective/tilt config — not a flat grid | ✅ px |
| **UX-10** | D — Board | Hover any card, anywhere, → full clear card view | One hover funnel for hand, battlefield, stack, prompts, graveyard, exile, reveals | ✅ |
| **UX-11** | D — Board | Tapped cards rotate 90° — **including while attacking** | Tap rotation is driven by `tapped`, composes with the attack transform instead of being overridden by it | ✅ |
| **UX-12** | D — Board | Attackers advance toward the defender, never past the midline | Attack offset is a named fraction of the half-board, clamped at the midline | ✅ |
| **UX-13** | D — Board | Blockers advance to meet the attacker they block | A blocker's tile moves toward its attacker's advanced position | ✅ |
| **UX-14** | D — Board | Fiery arced arrows for attack/block pairs | Replaces the current straight `CombatLines` segments: arcs, arrowheads, animated ember gradient | ✅ |
| **UX-15** | D — Board | Damage distribution animates at end of blocks | Damage travels visibly from source to each recipient (creature and player), sequenced so it can be followed | ✅ |
| **UX-16** | E — Provenance | Opponent's instants/sorceries are shown and inspectable **before** they resolve | A visible pause/announce for an opponent's spell even when the viewer has no response; inspectable card face | ✅ px |
| **UX-17** | E — Provenance | **Aftermarket characteristics rendered on the card, with provenance** | P/T, abilities, types, subtypes, name, colors — modified values shown in place with distinct styling; hover gives base + each contributing source; removals struck through; **plus** a keyword glossary tooltip on every ability word, printed or granted | ✅ px, two stated carve-outs |

### UX-17 is really four things — do not let it collapse to just P/T

1. **Effective value shown in place of printed** (4/5 → **5/6**) with an "altered" visual treatment.
2. **Provenance tooltip**: base value, then one row per contributing source, each naming the card.
3. **Granted abilities appear in the rules text** as if printed, styled as aftermarket; **removed**
   abilities appear struck through. Same treatment for type/subtype/name/color changes.
4. **Glossary tooltip on every ability word**, printed or granted, on every card in the app.

## 2. The systemic requirements (CLAUDE.md rules 10 & 12 applied to this scope)

These are the reasons this is an engine-and-UI job rather than a CSS job. Read them before writing
any code.

### 2.1 Provenance is a CORE capability, not a UI guess

`indexContinuous` (`packages/core/src/internal/continuous.ts`) already aggregates every continuous
effect into an `AggregatedMod` per instance — but it aggregates the **sum** and throws the
**attribution** away. UX-17 cannot be honestly built on top of a sum; a UI that guesses which
enchantment supplied the +1/+1 is a lie waiting to be believed.

**So: one funnel, extended, not a second one in the UI.** The aggregation gains a per-instance list
of contributions `{ sourceInstanceId, sourceName, what changed, by how much }`, and every consumer
— board tile, hover card, stack card, prompt card — reads that one list. A UI-side re-derivation is
the exact "two places answering one question" failure rule 12 forbids.

It must stay allocation-light: this runs in the sim hot path (rule 7). Attribution is built only
when asked for (a separate entry point / lazy field), never on every `effectivePower` read.

### 2.2 "Optional gate" is a TABLE, not a predicate about triggers

`apps/web/src/lib/play/optional-trigger.ts` already fixed the "may after targets" complaint — but
only for the narrow instance: a **triggered** ability, on the source's own `def.triggers`, with the
`mayEffects` primitive at the **top level** of the effect list, and only when `min > 0`. Caleb is
"still getting a lot of situations", which is the signature of a one-off fix on a class-shaped bug.

The class: **any ability whose effects are gated behind an optional decision, from any source kind,
at any depth of the effect tree.** The fix is a closed table of gate shapes (`mayEffects`, params
carrying `optional: true`, and whatever else the pool actually uses — **measure it, don't guess**),
a recursive scan over the whole effect tree, applied to triggers, activated abilities, spell
scripts and replacements alike. A shape not in the table **reports honestly** (falls back to the
current ordering) rather than being guessed at.

**Measure first (rule 11):** count, from the real pool, how many cards have each gate shape and how
many are missed by the current narrow rule. Ship that count in the report.

### 2.3 The two-phase cast must not fork the engine

The engine mutates during `castSpell` (pays costs, moves the card to the stack) and only then parks
a `selectTargets` choice. Rewriting that into a pre-commit proposal inside the engine is a large,
high-risk change to the hottest path in the project.

**The sound alternative** — and the one MTGA itself uses — is a **session-level transaction**: the
play session snapshots immediately before dispatching the opening action, stays in a `proposing`
phase while the caster answers their own pre-stack questions, and on cancel restores the snapshot.

This is only sound under an invariant that must be **stated, enforced and tested**: between the
opening action and commit, **no seat other than the caster has made a decision, and nothing hidden
has been revealed to anyone**. If a proposal ever reaches a state where that does not hold, the
cancel affordance must **disappear** (honest refusal), not silently rewind something a player saw.
Pin that with a test.

### 2.4 One hover funnel, one card renderer

`CardHover`, `CardZoomOverlay`, `PlayCard`, `CardTile`, `BoardPermanentTile` and the prompt cards
currently render cards several different ways. UX-8/UX-10/UX-17 all demand "show the real card,
with aftermarket annotations, wherever a card appears". That is one component with one props
contract, adopted by every site — not a sixth renderer.

### 2.5 Every visual constant is named and tunable

Perspective angle, tilt, attack advance fraction, midline clamp, arc curvature, ember colors,
damage-animation durations and stagger — all from a config module (rule 1/2), none inline. The
debug inspector gets controls for them (rule 3).

## 3. Definition of done for this overhaul

Beyond the standard §7 gate:

- **Every item above is either ✅ done or explicitly listed as deferred with a reason.** Partial
  silence is not acceptable — this file is the checklist.
- **Regression tests** for every behavioural item (rule 10 / the standing regression-test mandate):
  cancel-restores-state, may-before-targets across all source kinds, tap-rotation-while-attacking,
  midline clamp, provenance attribution correctness.
- **A runnable build** the user can actually play (rule 9), plus a short "what to look at" note.
- **No sim throughput regression** (rule 7) — the provenance work touches the stat pipeline;
  measure games/sec before and after and report both numbers.

## 4. What already exists (verified against `origin/main` @ 9b4524a, 2026-09-11)

Do not rebuild these; extend them.

| Already there | Where | What it still does NOT do |
| --- | --- | --- |
| Audio cues (§3.130) | `lib/play/sound-cues.ts`, `sound-engine.ts` | — |
| VFX layer (§3.131) | `components/play/VfxLayer.tsx`, `lib/play/vfx-cues.ts` | no damage-distribution sequence (UX-15) |
| Effects bench (§3.132) | `components/play/EffectsPreview.tsx` | the new systems must register here too (rule 3) |
| Opponent action feed (§3.133) | `components/play/OpponentActionFeed.tsx`, `lib/play/opponent-actions.ts` | it is POST-HOC — it says what already happened. UX-16 wants the spell HELD and inspectable BEFORE it resolves |
| Flight animations | `components/play/AnimationLayer.tsx`, `lib/play/animations.ts` | no damage arcs |
| Straight blocker lines | `components/play/CombatLines.tsx`, `lib/play/combat-lines.ts` | straight, not arced; no arrowheads; no fire |
| Named config convention | `lib/play/play-config.ts` (`VFX_CONFIG`, `OPPONENT_FEED_CONFIG`, …) | every new constant in this overhaul goes here |
| Narrow may-before-targets fix | `lib/play/optional-trigger.ts` (80 lines) | triggers only, top-level `mayEffects` only, `min > 0` only — see §2.2 |
| P/T delta on the tile | `BoardPermanent.ptDelta` in `lib/play/view-model.ts` | a bare "+1/+1" badge with NO attribution — see §2.1 |

**Confirmed still absent:** any CSS `perspective` / `rotateX` / `preserve-3d` anywhere (UX-9);
any provenance/attribution in `packages/core/src/internal/continuous.ts` (UX-17); any keyword
glossary module (UX-17.4); any card image on the stack — `StackPanel.tsx` is 43 lines of text
spans (UX-1).

## 5. Lane ownership

**The lane is the collision boundary.** An agent writes its lane's files and nothing else. Shared
files (`lib/play/play-config.ts`, `packages/core/src/index.ts`, `PlayBoard.tsx`) are owned by
exactly one lane each, named below.

| Lane | Owns (writes) | Consumes (reads only) |
| --- | --- | --- |
| **F — Foundations** | `lib/play/play-config.ts` (ALL new constants for every lane, added up front), `lib/play/keyword-glossary.ts` (new) + test | — |
| **E — Provenance core** | `packages/core/src/internal/continuous.ts`, `packages/core/src/index.ts`, new core test | — |
| **A — Stack** | `components/play/StackPanel.tsx`, `lib/play/stack-view.ts` (new), `components/play/stack-panel.css` (new) | F, E |
| **B — Commit** | `lib/play/proposal.ts` (new) + test, `lib/play/session.ts` | F |
| **C — Prompts** | `lib/play/optional-trigger.ts`, `lib/play/choice-view.ts`, `components/play/ChoicePrompt.tsx` | F, E |
| **P — Provenance UI** | `components/play/CardFace.tsx` (new), `components/play/card-face.css` (new), `lib/play/provenance-view.ts` (new) | F, E |
| **G — Combat arcs** | `components/play/CombatLines.tsx`, `lib/play/combat-lines.ts` | F |
| **H — Damage anim** | `components/play/AnimationLayer.tsx`, `lib/play/animations.ts`, `lib/play/vfx-cues.ts`, `components/play/game-fx.css` | F |
| **D — Board + wiring** | `components/play/PlayBoard.tsx`, `BoardPermanentTile.tsx`, `board-fit.css`, `board-clarity.css`, `views/PlayView.tsx`, `lib/play/view-model.ts` | everything above |

**D runs LAST** — it is the integration point, and it is the only lane allowed to edit `PlayBoard.tsx`.

## 6. Build-gate rules for every agent on this box

The box is 6-core / 7 GB. It has exactly one gate's worth of RAM.

- **Run only YOUR OWN test files** while other agents are working: `npx vitest run <paths> --minWorkers=1 --maxWorkers=2`. **Never** `npm test` / `npm run verify` / a full `npx vitest run` — a full suite beside sibling agents has died with a silent exit code 9.
- **Never start a dev server** (`npm run dev` / the Browser pane) while the suite runs. The integrator runs the browser harnesses, one at a time, at the end.
- Judge a suite by the `Tests  N passed | M failed` line, never the exit code.
- Every behavioural fix ships a test that fails without the fix (the standing regression mandate).

## 7. The wave-3 audit — what shipped, what did not, and what was measured

Written by the checklist lane after reading the code for all seventeen items and after looking at the
harness screenshots on disk. **It is a record, not a report card**: where a verdict rests only on
source it says so, because §3 of this file calls partial silence unacceptable and a `✅` that means
"the file exists" is a quieter kind of silence.

### 7.0 The evidence behind each row

One line per item, naming the file the verdict was read out of. Where a row says **adopted at**, that
is the wiring site — the thing wave 1 and wave 2 both had green tests for and both got wrong.

- **UX-1** ✅ `StackPanel.tsx:44-125` renders one `PlayCard face="full"` per row through `CardHover`
  (`:154-166`); ordering, labels and target descriptions are decided in the pure `stack-view.ts` and
  arrive settled; top-of-stack is `.stack-row--top` (`stack-panel.css:116`). Adopted at
  `PlayBoard.tsx:1795`.
- **UX-2** ◐ mounted and always-on (`PlayBoard.tsx:1785-1802`), but drawn over the log rail — §7.1.
- **UX-3** ✅ `proposal.ts` is the transaction; the snapshot is the retained prior immutable session
  (module header, "Snapshot, not replay"). Adopted at `PlayBoard.tsx:212, 247, 678-690`, and
  `proposal-adoption.test.ts:62` fails if any imported entry point is imported without being called.
- **UX-4** ✅ Escape is one named value read by handler, hint and test (`PlayBoard.tsx:1497-1499`);
  one `ProposalCancelButton` serves every pre-commit prompt (`:1953, 2141, 2184`, defined `:2289-2305`),
  and `proposal-adoption.test.ts:151` pins that there is exactly one such control.
- **UX-5** ✅ `rewindVerdict` refuses with `'announcementOver'` once `awaitingCastChoice` is gone and
  with `'resolving'` past CR 608.2 (`proposal.ts` header, "where the rules genuinely refuse"); the
  refusal is rendered as a sentence, not a missing button (`PlayBoard.tsx:674`).
- **UX-6** ✅ `OPTIONAL_GATE_SHAPES` is a closed 16-row table with a `why` per row
  (`optional-trigger.ts:121-218`), scanned recursively at any depth (`findOptionalGates`, `:544`)
  over every ability source a definition prints (`abilitySourcesOf`, `:400`, driven by the mapped
  `CARD_DEFINITION_FIELD_SCAN`, `:289`). **Measured, as §2.2 demanded:** 101 `EffectPrimitive`
  declarations scanned, 16 ask; 200 gate instances in the 5,651-card pool; the test re-runs the scan
  and fails in both directions.
- **UX-7** ✅ `FOLD_COPY.back` = "Change my mind" (`optional-trigger.ts:582`), rendered at
  `ChoicePrompt.tsx:312`; the answer survives the priority round in a ledger keyed by source **and
  submitted targets** (`optional-trigger.ts:676-710`, adopted `PlayBoard.tsx:1413, 1445`).
- **UX-8** ✅ source face at `ChoicePrompt.tsx:209, 357-359`, candidate faces at `:395-405, 639-660`;
  `cardIdOf` / `zoneOf` / `sourceDef` are all wired (`PlayBoard.tsx:1879-1882`). **px.**
- **UX-9** ✅ projection and tilt are split across two elements on purpose — `perspective` +
  `perspective-origin` on `.board-scene`, `rotateX` on the inner box (`board-scene.css:87-106`) —
  because the property and the `perspective()` function do not compose the way they look like they
  do; `transform-origin: 50% 100%` puts every point at z ≤ 0 so no headroom has to be reserved.
  Constants at `play-config.ts:264, 350-355`. **px.**
- **UX-10** ◐ one funnel, adopted in fifteen files; exile has no viewer — §7.1.
- **UX-11** ✅ `--perm-turn-deg` is set from `perm.tapped` alone (`BoardPermanentTile.tsx:390`) and
  the advance lives on a different element (`.perm-slot` / the stage layer), so the attack transform
  cannot overwrite the rotation — the two-element split is the fix and it is written down at
  `board-scene.css:123-171`. The tapped footprint is a flex-basis (`:401`) so a turned card reserves
  the width it occupies instead of overlapping its neighbour.
- **UX-12** ✅ `maxAdvancePx` is the single clamp both roles obey (`combat-stage.ts:164-171`) and it
  scales the WHOLE vector, never just its vertical part (`:175-192`); the midline is MEASURED off the
  `.board-midline` element (`board-fit.css:242-248`) rather than assumed.
- **UX-13** ✅ `STAGE_ROLE_RULES` is a two-row table, and the blocker row aims at the attacker's
  already-advanced centre (`combat-stage.ts:92-127`).
- **UX-14** ✅ `combatArcPairs` is the one funnel (`combat-lines.ts:130`), `COMBAT_ARC_KINDS` and the
  per-kind step table are rows (`:45-90`), the arrowhead convention is one stated rule (`:8-17`);
  `CombatLines.tsx:164-240` paints the gradient ramp and the animated ember dash, and drops the ember
  elements entirely under `prefers-reduced-motion` (`:158-161`).
- **UX-15** ✅ `damage-sequence.ts` decides what hits, in what order, from where to where and when;
  rounds come from core's own `damageDealt.round` marker rather than being re-derived, with two
  stated fallbacks and a closed `DAMAGE_ROUND_COMPANIONS` table whose default splits rather than
  blurs. `DamageLayer` adopted at `PlayBoard.tsx:2238`.
- **UX-16** ✅ `spell-hold.ts` — `HOLD_KINDS` is a mapped type over lane A's `StackEntryKind`, so a
  fourth kind stops the build until somebody decides; a hold grants no priority and answers no
  question, which is why it does not reopen report 20260901_211359. Adopted at
  `PlayBoard.tsx:2259-2272`, carrying the card's provenance explanation. **px.**
- **UX-17** ✅ attribution lives in `packages/core/src/provenance.ts` and deliberately NOT in
  `internal/continuous.ts` (`continuous.ts:62-70` says why, and a reconciliation holds the two walks
  in agreement); exported at `core/src/index.ts:433-453`. One renderer,`CardFace.tsx`, with a closed
  `SIZE_PRESETS` table (`:118-131`). The glossary is `keyword-glossary.ts`, reaching the full face
  (`CardFace.tsx:437`) and the hand (`play-card-live-face.test.ts`). `full-face-provenance.test.ts`
  derives the full-size mounts from `PlayBoard.tsx` and reddens when a new one arrives without an
  `explanation`. **px** for the merged/underlined ability words; carve-outs in §7.2.

### 7.1 The two partials, with exactly what remains

**UX-2 — the stack is always visible, and it is drawn on top of the game log.** The panel itself is
right: it is mounted unconditionally outside `.board-scene` (`PlayBoard.tsx:1785-1802`), it is
`position: absolute` rather than `fixed` so the UX-9 perspective cannot capture it
(`stack-panel.css:356-390`), it renders nothing when the stack is empty so it steals no width, and it
never needs a scroll at realistic depths. **What remains is one number.**
`.stack-panel--floating` pins itself with `right: var(--space-2)` — 8px from the right edge of
`.play-board`. Since wave 2 that edge is where the game log lives: `.board-rail` is
`flex: 0 0 var(--play-log-rail-w)` = 17rem (`board-fit.css:230-231`, fed from
`BOARD_LAYOUT_CONFIG.logRailWidthRem`, `PlayBoard.tsx:1343`). The panel has `z-index: 30` and the rail
has none, so **a non-empty stack paints over the log.** That is the identical defect lane X1 found in
`.opp-feed` by looking at a screenshot — see §7.3, finding 2 — and the sibling was missed because
nothing looked for siblings. The fix is the same one line on both:
`right: calc(var(--play-log-rail-w) + var(--space-3))`, with a `@media (max-width: 39.999rem)` reset
back to the plain offset, because below 40rem the rail folds under the table
(`board-fit.css:818-832`) and the corner is free again.

**UX-10 — CLOSED.** The funnel was always real and always one funnel: `CardHover` raises a `CardFace`
at `size="full"`, and fifteen files mount it — the hand and the battlefield, the stack, every prompt,
the graveyard, reveals, the mulligan, the effects bench, the online board. What was missing was never
the funnel but a ZONE: `SeatPanel` showed exile as a bare count chip, and the only exiled cards a
player could look at were the two special cases that already had a surface of their own — a card
jailed under its jailer (`BoardPermanentTile.tsx`, §3.57) and a madness cast offered out of exile
(`PlayBoard.tsx`).

Exile is now openable on BOTH boards and for BOTH seats, through the same panel the graveyard uses:
`GraveyardPanel` became `ZonePanel`, driven by the closed `ZONE_PANELS` table in
`lib/play/zone-panel.ts` (a row per zone: label, icon, cast badge, whether the zone can hold hidden
cards, and the sentences a disabled card is allowed to say). A third public zone later is a ROW.

⚠️ **And exile is NOT the graveyard.** A foretold card is exiled FACE DOWN and only its owner may
look at it (CR 702.143a, `CardInstance.faceDown`), so the masking is done at the VIEW MODEL:
`SeatView.exile` carries only the cards the viewer is entitled to identify and `SeatView.exileHiddenCount`
carries the rest as a number with nowhere for a name to travel. `maskStateForSeat` had already done
this half of the job since §3.112 — but `faceDownExileCount` had no consumer, and the online adapter
counted `exile.length` alone, so a foretold card of the opponent's did not exist online even as a
number. Both are fixed, and `components/play/exile-viewer.test.ts` renders the real panel on a real
masked view and fails if the hidden card's name or art reaches the markup.

### 7.2 The three carve-outs, stated rather than buried

These are refusals the code makes deliberately and documents at the refusal site. They are listed so
that "done" above is not read as "unlimited".

1. **A battlefield tile carries the condensed rules text, not the full one.**
   `SIZE_PRESETS.tile.rules === 'aftermarketOnly'` (`CardFace.tsx:119-124`): a ~96px tile shows the
   words that are visible nowhere else — the granted and struck-through lines — and the merged
   "vigilance, first strike, flying" line Caleb asked for is one hover away on the full face. The
   reason is written at the row.
2. **The online board gets no provenance.** `OnlineBoard.tsx:84-90` says so in as many words and
   passes `unavailableReason`, because that surface has no continuous index to attribute from. The
   board reports the absence instead of rendering an empty breakdown that would read as "nothing has
   been done to this card".
3. **An UNKNOWN gate shape falls back to today's ordering rather than being guessed at.**
   `isTabulatedGate` (`optional-trigger.ts:223`) is the honest refusal the scope's §2.2 demanded, and
   `foldedMayPrompt` refuses a second time when two gates in one source make it ambiguous which
   question a fold would be answering (`optional-trigger.ts:641`).

### 7.3 The three class-shaped findings, and what each one taught

**1. Built, tested, and unreachable — the defect shape of this entire branch.** UX-9 is the cleanest
specimen: wave 1 shipped `perspective: 1600px` and an 8° tilt, `board-scene.test.ts` was green, and a
real screenshot showed a flat vertical stack with no tabletop in it at all. The arithmetic is now
written down at `BOARD_TILT_DEG` (`play-config.ts:226-264`): against the 335px scene this board
really renders, 1600px puts the far edge at 97% of true width, which the eye reads as a rendering
artefact rather than as depth. 700px puts it at 91%. **The tilt was never the expensive knob — the
perspective was**, and no structural test could tell the difference because both values are equally
present in the stylesheet. The same shape produced every wave-2 gap: full-size card faces mounted
with no `explanation` while `provenance-view.ts` was fully tested (`full-face-provenance.test.ts`
header); two overlays aiming at a `life:<seat>` anchor no panel published, with a graceful fallback
that made it silent (`anchor-adoption.test.ts` header); the glossary reaching `CardFace` but not the
hand (`play-card-live-face.test.ts`). **The guards that actually work all share one property: they
derive the list of MOUNTS from the source and fail when a new mount appears without the prop**,
rather than asserting that a model computes the right value.

**2. A corner that used to be free.** `.opp-feed` and `.stack-panel--floating` both pin to
`right: var(--space-2)` of `.play-board`. That was a free corner until UX-9 moved the game log out of
the midline into a 17rem right-hand rail, and from that moment both overlays sat on top of the words
`GAME LOG`. One instance was found because somebody opened a PNG; the sibling is still open (§7.1).
**The class is "an absolutely-positioned board overlay pinned to an edge whose occupant changed", and
it has exactly as many instances as there are such overlays.** The guard it wants is a harness check,
not a unit test: in `verify-board-fits.mjs`, assert that no element in the board's overlay band
intersects `.board-rail`'s client rect. A CSS property test cannot see an intersection.

**3. A harness probe that matched more than it meant.** `verify-game-resume.mjs` decided both
"stopped mid-choice" (~line 215) and its post-reload assertion (~line 274) with
`document.querySelector('[role="dialog"]')`. Wave 2 gave `SpellHoldCard` `role="dialog"` for a
2.4-second timed announcement; the probe matched it, announced that the harness had stopped on a
parked question, reloaded, and found nothing — 18/18 became 17/18 and the finger pointed at the
proposal transaction, which was innocent. **Two lessons, and the second is the bigger one:** a probe
that selects by ROLE will match every future overlay carrying that role, so it must select by the
component's own class (`.choice-prompt` is the only ENGINE-parked question on this surface); and
`role="dialog"` on a non-modal timed announcement was itself a real accessibility defect, now
`role="status" aria-live="polite"`. **A red harness is a claim about the harness before it is a claim
about the code.**

### 7.4 The numbers

**Browser harnesses.** The play surface is gated by three (`verify-bug-reporter.mjs` is a fourth and
belongs to §3.113, not to this branch):

| Harness | What it proves | Result |
| --- | --- | --- |
| `node apps/web/scripts/verify-game-resume.mjs` | resume-exactly + defer-updates survive a real reload and a real service-worker update | **18/18 checks passed** — after the `role="status"` fix above; it was 17/18 with the loose probe |
| `node apps/web/scripts/verify-board-fits.mjs` | nothing scrolls, the status line / hand / action bar are on screen, at four viewport sizes including a phone | **32/32** (was 30/32 mid-branch: the scene wrapper added 171px of height, all of it the game log sitting between the battlefields) |
| `node apps/web/scripts/verify-mana-choice.mjs` | the auto-tap spares the useful source; the picker asks only when there is a choice and cancels cleanly | **19/19** (unbroken across the whole branch, including the wave-2 rewrite that replaced the picker with a proposal stage) |

⚠️ **The two missing tallies are missing on purpose, not lost.** Their artifacts are on disk in
`apps/web/verify-out/{board-fits,mana-choice}/` and post-date the last source edit on this branch, so
both harnesses did run against this tree — but the pass counts were never handed to the checklist
lane, and this file will not carry a number nobody measured. **The integrator must re-run both and
paste the `N/M checks passed` line into this table before §3.143 is marked done.**

**Sim throughput (rule 7 — the provenance work touches the stat pipeline).** Ten interleaved runs,
branch against `main`: **branch median 236 games/sec, main median 239** — a ~1.3% shading that sits
well inside this box's own 6–7% run-to-run spread. The like-for-like proof is in the result, not in
the timing: **A won 845/2000, identical on every run on both sides**, so the two builds played the
same 2,000 games and only the clock differed. Attribution stays opt-in and lazy
(`explainCharacteristics` is a separate entry point, not a field on every `effectivePower` read),
which is why the hot path is unmoved.

**What was verified against pixels, and what was not.** Verified by opening a real screenshot:
the tabletop keystone (`board-fits/03-tall-full-size.png` — both seat boxes render as trapezoids, the
far seat visibly narrower than the near one, UX-9); the held opponent spell with its full card face
and its two buttons (`board-fits/04-phone.png` — "Computer is casting: Aerial Responder", UX-16); a
target prompt whose candidates are six real card faces with their keyword words underlined
(`game-resume/01-live-board.png`, UX-8 and UX-17.4); the cancel affordance and its sentence
("Escape backs out — nothing has happened yet.", `mana-choice/03-picker-open.png`, UX-4). 

**✅ THE COMBAT HOLE IS NOW CLOSED — the integrator drove a real game to declared combat and looked.**
This paragraph previously read "no screenshot on disk shows a non-empty stack or a declared combat,
so every combat visual on this branch is an unobserved claim", and it was the single biggest hole in
the record. A throwaway rig (solo game, Selesnya Blink, drive until the stack is non-empty and until
`.perm--attacking` appears) wrote `verify-out/combat/`. What the pixels show:

- **UX-1 / UX-2 CONFIRMED.** `01-stack-nonempty.png`: a "STACK 1" panel carrying a real card image,
  "RESOLVES NEXT", the object's name, its kind and its controller — and it does NOT paint over the
  log rail. The same frame shows **UX-16** at its best: "Computer is casting:" with the full,
  readable Savannah Lions face and the "Keep looking" / "Let it resolve" buttons.
- **UX-11, UX-12, UX-14 CONFIRMED.** `02-attackers-declared.png`: an attacking Savannah Lions turned
  90° (it tapped to attack — the exact composition of tap-plus-attack that UX-11 exists for),
  advanced toward the defender and stopping short of the seam, with a **fiery orange arc curving
  from it to the defending player's life total** — which also confirms the `life:<seat>` anchor
  (wave 2's GAP-13), since before it the arc aimed at the creature row.
- **STILL UNOBSERVED: UX-13 and UX-15.** The rig reached declared attackers but not declared
  BLOCKERS (the driven seat had no creatures to block with in that game), so the blocker advance and
  the damage sequence remain source-only claims. That is now the biggest hole, and it is a much
  smaller one.
- **FOUND BY LOOKING, and fixed in the same pass:** the opponent feed printed its toasts over the
  words "GAME LOG". It was not one bug — `.stack-panel--floating` sits at the identical inset, so
  every overlay pinned to the board's right edge had the same defect. One shared token
  (`--play-board-right-overlay-inset`) and `right-overlay-inset.test.ts`, whose EXEMPT table forces
  the question nobody asked: pinned to WHAT?
- **STILL OPEN, seen and not fixed:** the battlefield tiles remain visibly smaller than the hand
  cards — an inverted size hierarchy versus MTGA, where the board is the thing you read. The
  "ATTACKING" badge and the card name run vertically on a turned card, which reads as broken rather
  than as a card lying on its side.

## 8. Standing note — how to check this surface, and when

**Structural tests could not see a flat tabletop, a clipped tooltip, an unstyled class or a prompt
nobody adopted. The browser harnesses and a real screenshot could.** Everything on this surface is a
LAYOUT or a VISIBILITY claim, and jsdom has no viewport, no flexbox, no `dvh`, no stacking context
and no perspective. A green `npm test` is evidence that the model is right; it is not evidence that
anything reached a player.

So, before calling any play-surface work done:

1. **Run all three harnesses, one at a time** (they each build the app and drive a real Chrome; the
   box has one gate's worth of RAM):
   ```
   node apps/web/scripts/verify-board-fits.mjs
   node apps/web/scripts/verify-game-resume.mjs
   node apps/web/scripts/verify-mana-choice.mjs
   ```
   Judge them by the `N/M checks passed` line and **paste it into §7.4**.
2. **Then open the PNGs they leave in `apps/web/verify-out/`.** "Exit 0" and "the picture is right"
   are different claims — the harness asserts geometry, and the four self-inflicted bugs wave 3
   caught (seats painting over the hand while the board reported that it fit; a phone rail losing a
   specificity contest inside a media query; a tap badge covering a land's whole art; the online
   board's tiles losing all art height to an unset custom property) were caught by LOOKING, and three
   of the four would have shipped with a fully green suite.
3. **For a layout question, rebuild the measuring rig rather than reasoning about CSS.** Copy
   `verify-board-fits.mjs`, replace `main()` with a per-element `{height, scrollHeight, clientHeight,
   top, bottom}` dump plus 2× device-pixel `page.screenshot({clip})` crops of individual rows. It
   takes two minutes and it is the difference between "I changed a flex property" and "the far strip
   is holding 24px it cannot use". **Delete it before you finish** — it sits under `apps/web/` and
   `npm run lint` walks `verify-out/`.
4. **Write a guard that derives its subject from the source.** The three tests on this branch that
   caught real unreachability (`full-face-provenance.test.ts`, `anchor-adoption.test.ts`,
   `proposal-adoption.test.ts`) all enumerate MOUNT SITES out of the source text and fail when a new
   one appears without the prop. A test that asserts a CSS property exists, or that a pure module
   computes the right value, cannot fail for the reason this surface actually breaks.

## 9. The ZONES as physical piles — raised 2026-09-14, NOT YET STARTED

> Raised by Caleb after the first fourteen items landed, with the explicit instruction to add it
> durably rather than carry it in a session. **Verbatim, so no later summary can trim a clause:**

> visually see all player's library of cards on their side of the table, as a physical stack of card -
> with nice animations for drawing, shuffling, putting on the bottom, milling, ect. Same for all
> player's graveyard and all player's exile. Graveyard should be face up pile next to library and
> clicking on it should let you view all cards in that player's graveyard in a nice way, with slight
> arcing/fanning to the horizontal line of cards, with a way to scroll back and forth across the
> cards, with the centered card always being at a neutral/none angle. Same goes for exile pile wrt
> viewing. But exile pile should render as face-down stack under the graveyard, but at a 90 degree
> angle so it visually sticks out from under the graveyard. Hovering over the exile should just show
> the top card of it as we do with many hover behaviors, with a hint that you can click on the pile
> to see all of them.

### 9.1 The work items

| ID | Item | One-line acceptance |
| --- | --- | --- |
| **UX-18** | The library is a physical stack on its owner's side | A real pile whose visible depth tracks the card count, seated on the tabletop — not a count chip |
| **UX-19** | Zone motion is animated | Draw, shuffle, put-on-bottom and mill each read as their own motion, distinguishable from one another |
| **UX-20** | The graveyard is a FACE-UP pile beside the library | Its top card is legible at rest, and it is clearly a pile rather than a badge |
| **UX-21** | The exile pile sits UNDER the graveyard, face-down, turned 90° | It sticks out from beneath the graveyard so both piles read at a glance; hovering shows its top card plus a hint that clicking opens it |
| **UX-22** | One fanned browser serves graveyard AND exile | Cards laid on a horizontal arc, scrollable side to side, with the CENTRED card always at zero rotation |

### 9.2 What is already in place, and what this supersedes

§7.1's exile gap (UX-10) is a **subset** of UX-21/UX-22 and must not be built twice. The
table-driven `ZonePanel` + `zone-panel.ts` added for that gap is the right substrate — it already
serves graveyard and exile from one closed table of zones — but its presentation is a flat list, not
the fanned arc asked for here. **Extend that panel; do not add a third zone viewer.**

The masking rule from UX-10 carries over UNCHANGED and is the one hard constraint in this section:
exile is NOT a fully public zone. `CardInstance.faceDown` exists for exactly this, so a face-down
exiled card renders as a BACK with no identifying data reaching the client — masked in the
view-model, never in the component. A fanned browser that reveals a face-down exiled card is a
hidden-information leak, not a cosmetic bug.

### 9.3 The trap this section will hit

Every visual item in §1 that shipped green-but-invisible did so because a transform or an
`overflow` ancestor ate it (§7.3). A stack of cards with depth, a 90°-turned pile and a fanned arc
are all transforms inside the tilted scene, so they will hit the same wall. **Budget for it, and
verify with a rendered frame rather than a passing test** — §8 says how.

## 10. MEASURED 2026-09-14: UX-13 and UX-15 are computed correctly and last too briefly to see

**This is the seventh instance of the branch's own failure shape — built, tested, unreachable — and
the first one where the code is entirely correct.**

### What was measured
A rig drove a real game to a real blocked combat (Wall of Omens blocking Savannah Lions, confirmed
in the game log along with `Savannah Lions deals 2 to Wall of Omens`). Immediately after clicking
**Confirm 1 block**, sampled at **260 ms** with the rig deliberately NOT passing priority:

```
BLOCKS CONFIRMED | blocking=0 staged=0 arcs=0 | Turn 7 · Main Phase 1 · Player 1's turn
```

Blocks, combat damage and end-of-combat had all resolved and the turn had advanced — inside a
quarter of a second, with no input. A subsequent 24-frame watch loop sampling every 45 ms never
once saw `staged > 0` for a blocker.

### Why the code is NOT at fault
`stageEntries` (`PlayBoard.tsx:1505-1534`) gates the blocker advance on `combat.blockersDeclared`,
which is correct per the rules and matches `combat-stage.ts`'s own design note. The entries ARE
built. `state.combat` is simply cleared again before a human eye — or a 45 ms sampler — can catch
them. Nothing here is a logic bug, which is exactly why 22,564 tests are green and the feature is
nevertheless not delivered.

### The requirement this fails
Caleb, verbatim: *"Animations when block phase is over and damage is being distributed to players
and creatures, just like MTGA does it, **so you can clearly see what's happening**."* An animation
that is correct and invisible does not satisfy that sentence. MTGA holds combat for roughly a
second precisely so the exchange can be read.

### The fix, and the precedent for it
**UX-16 already solved this exact problem and is proven working**: `spell-hold.ts` holds an
opponent's spell on screen before it resolves, and — critically — it gates BOTH the auto-passer and
the AI seat (`PlayView.tsx:909`, `:945`). That second gate is what makes it a real pause rather than
a decorated feed, and it is the part a naive implementation omits.

A combat hold is the same shape: after `blockersDeclared` becomes true, hold the board for a named,
tunable beat so the advance renders and the damage sequence plays out, then release. Requirements:

- **Named constants in `play-config.ts`** (a blocks-declared beat and a damage beat), never inline.
- **It must gate the AI seat and the auto-passer**, or it is cosmetic — see the UX-16 precedent.
- **It must not alter the rules or the action log**: a hold is a presentation delay, and the replay,
  the sim and the headless harness must be completely unaffected. The sim runs thousands of games
  and must never wait on it.
- **The guard is a rig, not a unit test.** No unit test can catch "this state existed for 200 ms";
  the check is the harness sampling `staged > 0` for a blocker after Confirm. That is the only
  guard shape that would have caught this.

### ✅ SHIPPED 2026-09-14 — what was built, and the numbers

**The design.** `apps/web/src/lib/play/combat-hold.ts` — a pure, DOM-free decision in the image of
`spell-hold.ts`: a closed `COMBAT_HOLD_KINDS` table with two rows (`blocksDeclared`, `damage`), a
closed `COMBAT_HOLD_REFUSALS` set, and `combatHoldDecision`, unit-tested in `combat-hold.test.ts`.
Nothing in `packages/` imports it or can.

**The two gates, both in `PlayView.tsx`.**
1. **The auto-passer, gated INSIDE its `shouldStop` predicate** — not only by an effect-level early
   return. `autoAdvancePriority` walks many priority windows inside ONE effect, so a gate outside the
   loop cannot stop it partway, which is exactly why the 260 ms sample landed on the next turn.
2. **The AI seat** — `if (hold || combatHold) return;`, so the computer cannot pass priority
   underneath the beat and resolve the combat the player is being shown.

**The constants** (`play-config.ts`, `COMBAT_HOLD_CONFIG`) are DERIVED from the animations they
exist to reveal, never hand-tuned: `blocksDeclaredMs` = the advance's travel + a full stagger tail +
a board-reading beat (**1025 ms**); `damageMs` = one hit's travel + the stagger between three hits +
the impact bloom + the settle (**1040 ms**, against `DAMAGE_ANIM_CONFIG.travelMs` of 340).
`prefers-reduced-motion` selects the row's OTHER beat — a NUMBER, the convention
`reducedMotionTiltDeg` set — rather than switching the hold off. A "Skip" affordance ends it now,
the equivalent of UX-16's "Let it resolve".

**The guard** is `apps/web/scripts/verify-combat-visibility.mjs`, which replaces the throwaway rig.
Measured both ways on the same tree:

```
hold disabled (the shipped behaviour before this change) — 1/6 checks passed
  FAIL  a BLOCKER IS STAGED after Confirm
        best stagedBlockers=0 over 6000ms | staged=0 (blockers 0) declaredArcs=0 arcs=0
        blocking=0 attacking=0 | Turn 7 · Main Phase 1 · Player 1's turn
  FAIL  the confirmed block gets a DECLARED arc — declared arcs 2 → 0 (-2)
  FAIL  the DAMAGE LANDS ON THE COMBAT BOARD — damage bloomed only after combat was gone

hold enabled — 6/6 checks passed
  PASS  a BLOCKER IS STAGED after Confirm
        staged=3 (blockers 1) declaredArcs=3 arcs=6 blocking=2 attacking=4
        | Turn 6 · Declare Blockers · Computer's turn
  PASS  the confirmed block gets a DECLARED arc — declared arcs 2 → 3 (+1)
  PASS  the DAMAGE LANDS ON THE COMBAT BOARD
        dmgLayer=1 impacts=2 bolts=2 | Turn 6 · Combat Damage · Computer's turn
```

Note what the disabled run PASSED: `dmgLayer=1 impacts=2` at **Main Phase 1 of the next turn**. The
damage layer mounting proves nothing on its own, which is why the check is "damage lands while the
board is still in combat" and not "the layer exists" — the first version of that assertion passed
without the fix, and an assertion that passes either way proves nothing.

### ✅ SHIPPED 2026-09-14 — the ONLINE board, the half that was left explicitly unfixed

The hotseat fix above closed with a stated carve-out: *"The online board is not covered.
`OnlineBoard.tsx` / `apps/server` have their own advance path and get no hold; … Same combat, same
invisibility, if anyone plays online."* That is now closed, with **no second decision and no
protocol change**.

**One decision, two boards.** `combat-hold.ts` is reused UNCHANGED — the protocol carries `combat`
as core's own `CombatState` (`packages/protocol/src/index.ts`, `MaskedGameView.combat`), so
`combatWindowFactsOf` adapts the masked view with nothing to translate and no adapter was needed.
`COMBAT_HOLD_KINDS`, `COMBAT_HOLD_CONFIG` and `NO_BEATS_SPENT` are read by both boards; the last of
these moved from a private const in `PlayView.tsx` into `combat-hold.ts` so the two boards stopped
writing their own empty set.

**Where the online gate sits, and why there.** The online analogue of the hotseat's `shouldStop`
predicate is the `autoPass` VALUE the auto-pass effect acts on, so the hold is composed into that
value through `shouldAutoPassNow(window, heldForCombat)` (`lib/online/auto-pass.ts`) rather than as
an early return around the effect. `shouldAutoPass` stays a rules-shaped predicate — *"is passing
the only thing this seat may legally do?"* — exactly as `shouldStopForPriority` does on the hotseat
side; the beat is ANDed in at the one place the answer is consumed. The second argument is
**required**, so a board that asks the rules question without answering the hold one does not
compile.

**One gate is enough here, and the hotseat's second one has no online twin.** The hotseat needs a
second gate because it runs the opponent (the AI seat) in the same component. Online there is no AI
seat: the opponent is another client running *this same component with this same gate*. The server
is authoritative and has **no auto-advance of its own** — `apps/server/src/index.ts` runs only a
socket heartbeat and an empty-room sweep, and `Room.submitAction` moves the game only when a seat
submits — so a client that declines to auto-pass genuinely holds the window rather than decorating
one. Both seats hold the same beat concurrently, so the added latency is one beat, not two.

**Nothing in the protocol moved.** A hold is presentation only: it delays one client's own
`passPriority` by a named, tunable number of milliseconds, which is indistinguishable to the server
from a human thinking. The wire format, the action log, the replay and what the server accepts are
untouched, and `apps/server` was not edited.

**The guard** is `apps/web/src/components/online/online-board-parity.test.ts`, extended with a real
`maskStateForSeat` view of a real blocked combat. It asserts the board announces the beat (worded
from the KIND row, not re-written), paints the blocker as blocking, and — the load-bearing one —
does **not** claim to be advancing while a beat is owed. That assertion is **two-sided**: the
control frame (`blockersDeclared: false`, everything else equal) must SAY `Nothing to do this step —
advancing…`, so the held frame's silence cannot pass vacuously. Falsified by replacing the gate
argument with `false`:

```
Tests  2 failed | 10 passed (12)
  × STOPS this board advancing under the beat — and the control proves it
    → expected '<div class="play-board">…' not to contain 'Nothing to do this step — advancing…'
  × each board's OWN advance path asks the hold before it moves
    → expected 'import { useCallback, …' to contain 'combatHold !== null,'
```

The other ten stayed green, which is the point: the banner still rendered with the gate gone, so the
reddened assertion is about the ADVANCE and nothing else.

**The parity assertion (rule 12).** Both boards now mount the same extracted `CombatHoldBanner`
component, and the test compares the two boards' rendered banner markup **byte for byte** — a
re-wording or a restyle can no longer land on one board and miss the other. A second assertion
checks that each board's own advance path still asks the hold, since the two advance paths are
genuinely different shapes (a synchronous local priority walk vs. a server frame stream) and that is
the "second copy is unavoidable — add a test that fails when they diverge" case.

#### ⚠️ What the online hold revealed was LESS than what the hotseat hold revealed — SUPERSEDED by §11

As shipped on 2026-09-14 this paragraph read: *"`OnlineBoard` has no `.board-scene`, no midline
element, no `CombatStage` and no `DamageLayer` — UX-9/UX-12/UX-13/UX-15 reached `PlayBoard` only …
porting the stage and the damage layer to the online board is a separate work item and is NOT done
here."* It is kept, struck through, because the sentence names the defect §11 removed: **the work
item was never four ports, it was one extraction.** Both boards now mount the same `BoardScene`, so
the online beat holds up the advance and the arcs as well as the bands, the life totals and the
log line. The one half that is still genuinely absent is the damage sprite, and §11 says exactly
why (the protocol carries no event stream) and exactly what would fix it.

---

## 11. SHIPPED 2026-09-14 — the two boards stopped being two boards

### The measurement this started from

`OnlineBoard.tsx` already imported **eleven** components from `components/play/`: `SeatPanel`,
`StackPanel`, `PlayCard`, `ChoicePrompt`, `AbilityPrompts`, `CardFace`, `CardZoomOverlay`,
`CombatHoldBanner`, `CombatLines`, `ZonePanel`, and `usePrefersReducedMotion`. **The leaves were
never the fork.** What had never been extracted was the SCENE COMPOSITION, which lived inline in
`PlayBoard.tsx`'s JSX:

- the `.board-scene` / `.board-scene__table` wrapper carrying UX-9's tilt;
- the `--board-*` custom properties fed from `BOARD_3D_CONFIG` / `BOARD_LAYOUT_CONFIG` /
  `TAP_ROTATION_CONFIG` / `COMBAT_ADVANCE_CONFIG`;
- the `.board-midline` element UX-12's advance clamp MEASURES against;
- `CombatStage` and the `StageEntry[]` it advances;
- the combat arcs and the damage layer.

So §10's closing paragraph — *"`OnlineBoard` has no `.board-scene`, no midline element, no
`CombatStage` and no `DamageLayer` … porting the stage and the damage layer to the online board is a
separate work item"* — named the symptom. **Porting features one at a time across two boards forever
IS the bug.** `apps/web/src/components/play/BoardScene.tsx` is the one unit both boards now mount.

### The seam — what is a PROP, and what was UNIFIED

A prop is what GENUINELY differs: the view model's source (a local engine vs. a server-masked
frame), the interaction handlers, the viewer seat, the rail's contents, the measure key, and the
damage source. Everything else that differed, differed only because nobody had unified it, and is
now decided once inside the scene:

| was two answers | is one |
|---|---|
| the opponent's fanned backs drawn ABOVE their battlefield (hotseat) vs. BELOW it, between their creatures and the midline (online) | the far edge of the table, always — where a player opposite you holds their hand |
| the viewer's hand OUTSIDE the scene (hotseat) vs. inside the seat region (online) | outside — a tilted hand is unreadable, and under `transform-style: flat` there is no counter-rotation that undoes it |
| the game log in a side RAIL (hotseat) vs. a centre COLUMN between the battlefields (online) | the rail; the column cost the online table the same 171px it cost the hotseat one |
| `combatArcPairs` (attacks + blocks) vs. `blockerLinePairs` (blocks only) | `combatArcPairs`, so the online board draws attacker→player and attacker→planeswalker arcs too |
| `stageEntries` derived from `session.state.combat` — which the online board does not have | `stageEntriesFor(view, viewer)`, derived from the SHARED `BoardView.combat` |
| two copies of the battlefield inspect gesture, two `permById` indexes, two drop-zone class lists | one each |

**`BoardView.combat` grew the fields it always should have carried.** `attackersDeclared`,
`blockersDeclared` and `attackTargets` were dropped by both builders; the hotseat board worked around
it by reaching past the view model into `session.state`, which is precisely why the online board —
which has no session — could not derive an advance at all. One `boardCombatView()` funnel in
`view-model.ts` now fills them for both. **The mask was not widened to do it:** `maskStateForSeat`
already sends `combat: state.combat` unredacted, and combat is public by the rules.

### What the online board GENUINELY renders now, and what it does not

| | reaches the online board | how it is known |
|---|---|---|
| **UX-9** tilt | ✅ | `--board-tilt-deg:12deg` / `--board-perspective-px:700px` are in the rendered `.play-board` style attribute on BOTH boards, asserted from `BOARD_3D_CONFIG` rather than re-spelled |
| **UX-12** advance + midline clamp | ✅ | both boards render `.board-midline` (the element `CombatStage` measures), and `stageEntriesFor` returns the same attacker advance from either board's view model |
| **UX-13** blocker advance | ✅ | from one real blocked combat, both view models yield `{blocker, role:'blocker', toward:-1, meets:attacker}`; the control one beat earlier yields `['attacker']` only |
| **UX-14** attack arcs | ✅ | the scene calls `combatArcPairs` with the attack half supplied; `blockerLinePairs` is deleted |
| **UX-15** damage | ❌ **NOT REACHED — and it is a missing CHANNEL, not a masking limit** | see below |

**⚠️ UX-15, stated honestly rather than claimed.** `deriveDamageSequence` needs the engine's
`GameEvent` stream. The server's `state` message carries `MaskedGameView` + `legalActions` +
`yourTurn` + `log`, and `Room.summarizeEvents` (`apps/server/src/room.ts`) folds the events down to
**five kinds of pre-formatted English string**, throwing the structure away. An online client cannot
derive the sequence from that, and deriving one from frame diffs would be a second answer to "what
damage happened" (rule 12). The scene therefore takes `NO_DAMAGE_SOURCE`, a named constant whose doc
comment carries this paragraph. **This is not a hidden-information problem** — combat damage is
public by the rules and the server already narrates it to both seats in prose. The fix is a field on
the `state` message carrying a CLOSED list of public event kinds; the call site is then one prop.

### The guard, and its falsification

`online-board-parity.test.ts` already mounted the REAL online board on a REAL `maskStateForSeat`
view and compared the two boards' `CombatHoldBanner` markup byte for byte. It now does the same for
the scene: one real blocked combat, both boards rendered from it, and their scene SKELETONS compared
in DOM order —

```
board-stage > board-scene > board-scene__table >
  play-board__opponent > play-hand--hidden, board-midline, play-board__self > drop-zone
then board-rail
```

a whitelist, so the seats' different cards cannot make two identical scenes look different, and a
missing midline cannot hide inside a diff of card art. Four more assertions: the tabletop numbers
reach both roots; the same blocker walks out from either view model (with the one-beat-earlier
control); `CombatStage` still renders **nothing** under `renderToStaticMarkup` on both boards, since
an advanced copy is placed from measured rects and a server-rendered one would be placed from rects
that do not exist; and the scene widened no mask.

**Falsified by deleting the `<BoardScene … />` element from `OnlineBoard.tsx`:**

```
Tests  4 failed | 32 passed (36)
  × BOTH boards draw the same scene … > renders a BYTE-IDENTICAL scene skeleton from the same blocked combat
    → expected [] to deeply equal [ 'board-stage', 'board-scene', …(7) ]
  × §10 … > paints the blocker AS blocking — the picture the beat exists to show
  × board-scene.test.ts > OnlineBoard.tsx keeps every one of its own overlays OUT of the scene element
  × board-scene.test.ts > OnlineBoard.tsx: the viewer's OWN hand is outside the scene
```

Restored: `Tests  36 passed (36)`. Note which assertions did **not** move — the tabletop-numbers one
stayed green, because `useBoardSceneVars()` is spread on `.play-board` independently of the scene
element. That is the separation working, not a hole: one guard is about the properties and the other
is about the composition.

### The online board, PHOTOGRAPHED (2026-09-14)

Everything above about the online board would otherwise rest on `renderToStaticMarkup`, and this
repo has shipped seven items that were green and unreachable (§7.3, §10). So
`apps/web/scripts/see-online-board.mjs` drives a **real two-seat online game** — two isolated
browser contexts against a real `apps/server` over a real socket — and photographs it into
`apps/web/verify-out/online/`.

At the opening board, read off the live DOM of the HOST seat:

```
SCENE {"boardScene":1,"table":1,"midline":1,"tiltVar":"12deg","seats":2,"stack":0}
```

and at the first real combat:

```
ONLINE COMBAT (host) | attacking=2 staged=1 arcs=3
ONLINE ADVANCE best: staged=1 arcs=3 midline=1 on host
```

`03-online-advance-host.png` shows, on the ONLINE board: both seat boxes drawn as keystoned
trapezoids (the far seat narrowing toward the top — the UX-9 projection, not a border effect); the
Guest's attacking Goblin Guide **lifted out of its home row and advanced down toward the midline**
(the `.combat-stage__tile`, placed against the `.board-midline` this board now renders); and a
**dashed fiery arc from that attacker to the Host's life total** — an attacker→PLAYER arc, which is
precisely the arc kind the online board could never draw while it called the block-only
`blockerLinePairs`. The game log sits in the right-hand rail and the viewer's hand is flat and
full-size below the table.

`attacking=2` beside `staged=1` is not a discrepancy: a staged card leaves its home tile in place as
a faint place-holder, and the home tile keeps `perm--attacking` — one creature, two elements. Only
`data-perm-id` moves to the copy.

**UX-13 is the one still unphotographed online.** That combat was unblocked (the defender had an
empty battlefield), so no blocker had anything to advance to. Its evidence is
`online-board-parity.test.ts`: from one real blocked combat, `stageEntriesFor` returns the identical
`{blocker, role:'blocker', toward:-1, meets:attacker}` from the MASKED online view model and from
the hotseat one, with the one-beat-earlier control returning `['attacker']` alone. That is a strong
pure-function equality and it is not a photograph; stated as such.

### What went with the fork (rule 5)

- `.play-board__center` and every rule that painted it (`board-fit.css`, `styles.css`) — no board
  renders that class now, and a rule that paints nothing is read as a live layout by the next person;
- `blockerLinePairs`, whose own doc comment said it existed because *"only one of the two boards
  knows about attack targets yet"*. Its adapter test is repurposed to the claim that outlives it: no
  attacker in, no attack arc out, at every step `STEP_ORDER` knows;
- six stylesheet/source comments describing the old split, including `board-fit.css`'s note that the
  online board *"sets none of `PlayBoard`'s inline custom properties"* — it sets all of them now.
## 12. SHIPPED 2026-09-14 — the game decided FOR you, and said nothing

Two reports, one week after §10, and the same sentence underneath both: *the game did something
and the player cannot tell what*. **This is the eighth and ninth instance of the branch's signature
failure**, and the eighth one is again a case where the RULES ARE ENTIRELY CORRECT.

### The reports, verbatim

> "whoah - I just played Banisher priest and it didnt let me choose a creature to banish - thats a
> REALLY BAD REGRESSION"

…and then, on working out the cause himself:

> "Oh - its because there was only one option in this case... I see. Even so, **it should show that
> choice being made so the player understands what has happened.**"

> "When the computer plays Doom Blade when Im playing them, it does not show me clearly what the
> target is when it displays on screen - it should show their target(s) for things along with the
> card they are casting."

### Where the settle actually is — measured, not assumed

A rig cast the real Banisher Priest into a board holding exactly one opponent creature and printed
every event:

```
triggerPutOnStack    "Enters: exile target creature an opponent controls until this leaves"
choiceAutoAnswered   choiceKind=selectTargets answer={targets:[121]} reason="only one legal target"
triggerTargetsChosen targets=[121]
```

…and with TWO opponent creatures the same cast emits `choiceAsked` and parks. So:

- **It is CORE's settle**, `aimPendingTriggers` → `isTrivialChoice` (`engine.ts`), not the client's.
  The three `ASK_WHEN_ONLY_ONE_ANSWER` sites in `apps/web/src/lib/play/proposal.ts` are not involved
  at all — that table covers casts and activations, and its `targets` row already says ASK.
- **It is right, and it stays.** The sim and the pilots depend on a game that never stops to collect
  an inevitable answer (`SOAK_RUNAWAY_FORCED_EVENT` counts these).
- **What was missing is that nothing said so.** `play-format.ts` explicitly dropped the event, with
  the comment *"a single-legal-answer auto-answer is bookkeeping, not narrative"*. That sentence was
  the bug.

### What shipped

**One mechanism, three surfaces.** `apps/web/src/lib/play/forced-choice.ts` is a pure, DOM-free
decision in the image of `spell-hold.ts` and `combat-hold.ts`: a closed `FORCED_CHOICE_KINDS` table
**mapped over core's own `ChoiceKind`**, a closed `FORCED_CHOICE_REFUSALS` set, and
`forcedChoiceDecision`. The mapped type is the class guard: a new choice kind in
`packages/core/src/choices.ts` stops the build here until somebody writes its words, so a kind
cannot go silent by omission. Each row carries the VERB, the words for an answer that named nothing,
whether the SHARED hotseat log may name the answer (`selectCards` may not — its candidates can be a
hand), and how loudly it reports.

**Core gained the provenance it already gave `choiceAsked`.** `choiceAutoAnswered` now carries
`sourceInstanceId` + `sourceName` at all seven emit sites. Without it no consumer can name the asking
card except by correlating the NEXT event, which is a second answer to "who asked?".

**`AUTO_SETTLE_POLICY` replaces `ASK_WHEN_ONLY_ONE_ANSWER`** (`proposal.ts`) as a discriminated
union: a row that SETTLES must name the `ChoiceKind` whose phrasing it borrows, so
`{ ask: false, settles: true }` with nothing to say does not compile. That is "a kind with no
phrasing must ASK" expressed as a type. Its one settling row — the single-legal-payer sacrifice cost
— now rides out on the committed step and is announced through the SAME funnel.

**`CardReferences.tsx`** lifts `StackTargetRow` out of `StackPanel.tsx` so the stack panel, the
opponent-spell hold and the new banner all draw "what this is pointing at" with one component, one
closed presentation table (`inline` / `face`) and one builder (`stack-view.targetView`).

### The second defect, which only the rig could find

`SpellHoldCard` gained the held spell's targets — and the first capture showed them EMPTY, above a
game log that already read:

```
Computer casts Doom Blade. / Doom Blade resolves. / Grizzly Bears dies.
```

**UX-16's hold was announcing a spell that had already resolved**, which is why it had no target to
name. Two causes, both §10's, and neither visible from source:

1. the auto-passer's `shouldStop` predicate never asked the spell-hold rule (only the combat-hold
   one), and a gate outside `autoAdvancePriority`'s loop cannot stop it partway;
2. the arming effect booked `announced` immediately, so when the predicate DID ask it got
   `alreadyAnnounced` — **the announcement defeating its own gate**. `releaseCombatHold` already
   writes down that booking belongs on RELEASE; UX-16 never did it.

`spellHoldFor` is now one callback asked by both, and the booking moved to `releaseHold`.

### The numbers

- `npm run build` — **exit 0**.
- `npx vitest run apps/web packages/core --minWorkers=1 --maxWorkers=2` —
  **Tests 3283 passed, 0 failed | 242 files**.
- `verify-combat-visibility.mjs` **6/6**, `verify-board-fits.mjs` **32/32**.
- `verify-forced-choice.mjs` (new) **12/12**, both reports photographed:

```
PASS  it NAMES the card that was chosen for you — "Banisher Priest targets Grizzly Bears"
PASS  the chosen card is drawn as a CARD, not a name string — faces=1 names=["Grizzly Bears"]
PASS  the GAME LOG carries it too
      "Banisher Priest targets Grizzly Bears — only one legal target."
PASS  the hold NAMES what the spell is aimed at — ["Grizzly Bears"]
PASS  the whole hold is ON SCREEN — target and buttons included
```

Two existing guards caught real defects in this work and are worth naming: `board-scene.test.ts`
rejected a literal `220ms` fallback inside an `animation:` declaration, and
`play-class-coverage.test.ts` rejected `forced-choice__refs` as a class no stylesheet mentioned.

### What is NOT covered, stated rather than buried

**The online board gets the log line and nothing else.** `@jonny-boi/protocol` carries masked STATE,
not `GameEvent`s, so `OnlineBoard` cannot see a `choiceAutoAnswered` at all and mounts no banner. The
component and the decision are board-agnostic and ready for it; the missing half is the event stream
(`feat/online-event-stream` is that work). Same for the opponent-spell hold, which the online board
has never mounted.
