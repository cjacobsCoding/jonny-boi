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

| ID | Lane | Item | One-line acceptance |
| --- | --- | --- | --- |
| **UX-1** | A — Stack | Stack shows real card faces, not names | Every stack object renders its card image at a readable size, top-of-stack marked, hoverable to full-size |
| **UX-2** | A — Stack | Stack is always visible when non-empty | No scroll, no panel hunt — the stack occupies a fixed, always-on-screen region during any priority window |
| **UX-3** | B — Commit | Two-phase cast/activate: **propose → confirm** | From opening a cast to confirming targets, **zero** game-state mutation is visible; cancel restores byte-identical state |
| **UX-4** | B — Commit | Cancel is idempotent and always available pre-commit | Escape / an explicit Cancel returns to the pre-proposal board from ANY pre-commit step, repeatedly, with no side effects |
| **UX-5** | B — Commit | Post-commit is irreversible and lands on the stack | Once confirmed, the object appears on the stack; no cancel affordance is offered (unless the rules genuinely allow one) |
| **UX-6** | C — Prompts | "May" is asked **before** targets — for the whole CLASS | A **closed table** of optional-gate shapes; asked for triggers, activated abilities, spells, replacements alike — not just `def.triggers` |
| **UX-7** | C — Prompts | Saying yes to a "may" is still reversible until commit | Answering the may and then backing out at the target step leaves nothing on the stack |
| **UX-8** | C — Prompts | Every target prompt shows the **source card's face** | The card provoking the choice renders as an image, not a name string; candidates render as card faces too |
| **UX-9** | D — Board | 3D tabletop: perspective, tilted, from the player's seat | A real CSS 3D scene with a named, tunable perspective/tilt config — not a flat grid |
| **UX-10** | D — Board | Hover any card, anywhere, → full clear card view | One hover funnel for hand, battlefield, stack, prompts, graveyard, exile, reveals |
| **UX-11** | D — Board | Tapped cards rotate 90° — **including while attacking** | Tap rotation is driven by `tapped`, composes with the attack transform instead of being overridden by it |
| **UX-12** | D — Board | Attackers advance toward the defender, never past the midline | Attack offset is a named fraction of the half-board, clamped at the midline |
| **UX-13** | D — Board | Blockers advance to meet the attacker they block | A blocker's tile moves toward its attacker's advanced position |
| **UX-14** | D — Board | Fiery arced arrows for attack/block pairs | Replaces the current straight `CombatLines` segments: arcs, arrowheads, animated ember gradient |
| **UX-15** | D — Board | Damage distribution animates at end of blocks | Damage travels visibly from source to each recipient (creature and player), sequenced so it can be followed |
| **UX-16** | E — Provenance | Opponent's instants/sorceries are shown and inspectable **before** they resolve | A visible pause/announce for an opponent's spell even when the viewer has no response; inspectable card face |
| **UX-17** | E — Provenance | **Aftermarket characteristics rendered on the card, with provenance** | P/T, abilities, types, subtypes, name, colors — modified values shown in place with distinct styling; hover gives base + each contributing source; removals struck through; **plus** a keyword glossary tooltip on every ability word, printed or granted |

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
