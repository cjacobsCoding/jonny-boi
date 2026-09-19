# The 2026-09-19 TODO — Lab trim, manabase experiments, infinite combos, gathered feedback

> Caleb, 2026-09-19 (verbatim, the four items):
>
> - *make it so there is a way in the lab to reduce a deck down towards 60 (but this should be tunable
>   so you can set your own custom limit if you want) where it basically tries removing certain cards,
>   sees of the deck does better or worse with the removed cards, then if the removal made it better, it
>   shows you that result and you can click apply. If it made it worse, it should either try again, or
>   pause and tell you - based on what you set it to, whether it should keep looking or pause and ask.
>   There should also be a setting for it to auto-make improving removals, and keep looking for more -
>   if every single combination of removals did not result in an improvement but we havent gotten down
>   to the target quantity, it should inform the user and tell them the results and the most likely
>   improving removal in case they want to apply those on-the-edge removals anyways. The removals should
>   take mana into account - for example, removing 3 non-lands probably means removing a land or two as
>   well... This should be handled intelligently.*
> - *make it so the lab can experiment with different manabases - both amounts and types of lands - to
>   see which makes the deck perform better and more reliably. Right now, there arent really any tools
>   for that yet*
> - *add support for detection of an infinite combo - in other words, a combination of things that
>   could be done in a loop infinitely to gain some infinite advantage - like infinite +1/+1 tokens on
>   all creatures, specific creatures, ect - or infinite life. Or deal infinite damage. Or infinite
>   creature tokens. Ect. Some infinite combos dont actually yield an infinite change - like tapping an
>   artifact to untap another, and tapping that one to untap the first - shouldn't be considered an
>   infinite combo worth considering because there's no net infinite change. But if there is an infinite
>   net change, the game must be able to express that competently - like if it detects that you have
>   been stepping through what results as an infinite combo, it should do a pop up that highlights the
>   infinite combo, and lets you agree to trigger it infinitely or not - it should also have options to
>   only trigger it a specific amount of times - up to some large number limit. If you choose to do it
>   infinitely, then it should somehow visually represent that infinity state. So if you have infinite
>   life now, it should show an infinity symbol. If you dealt infinite damage to a player, it should just
>   kill them unless some other rule prevents it. If you got infinite creature tokens, it should visually
>   represent that somehow and batching tools would be needed so you can deal with that infinite creature
>   force in ways that you should be able to - like tapping all infinite of them. Or you should be able
>   to choose to do something with only X of them - with the remaining cohort being treated as of
>   infinite size still. Creatures with infinite +1/+1 tokens, should be represented somehow.*
> - *address all gathered unaddressed feedback*

This file is the shared contract for the four lanes. Each lane's DESIGN section (§3.174+) records
what shipped; this file records what was ASKED and how the work was cut so the lanes do not collide.

## Lane T — the Lab TRIM (deck reduction) — `feat/lab-trim`

**What it is.** A Lab mode beside Suggest: *"bring this deck down to N"*. Each ROUND evaluates
single-card REMOVALS of the current deck with the same paired A/B machinery Suggest uses (common
random numbers, McNemar, the adaptive wave ladder, Holm over the family) — a removal is a swap whose
"in" is nothing. The best removal that comes back **better** is either shown for the user to **Apply**
or, in auto mode, applied and the next round started, until the deck is at the target.

**Settings (all tunable, persisted like the other Lab settings):**
- target size — default 60, any integer ≥ the format's `minDeckSize`; the panel says how far the deck is from it;
- on an improving removal — `ask` (show the result, Apply button) | `auto` (apply and keep looking);
- on no improving removal in a round — `keep looking` (widen: pairs, the next-best round) | `pause and ask`;
- games per candidate / precision — the Suggest controls, reused, not re-invented.

**Mana-aware.** Removing nonlands drifts the land ratio. The candidate set every round contains the
distinct nonland cards AND the distinct lands; a prior favours the type that restores the base deck's
land ratio (after cutting 3 nonlands from 24/60, a land is due). When a round's winner is a nonland
and the drift has reached one whole land, the NEXT round's candidates are lands first. Never a
hidden rule: the panel shows "lands 24/63 → target ratio 24/60 → a land cut is due".

**Exhaustion.** When no removal in the round is better and the target is not reached, the panel
reports it plainly: the round's table (every removal, its verdict and delta), and *"the most likely
improving removal"* — the best delta among the inconclusive ones — with an Apply button labelled as
on-the-edge. Nothing is applied silently.

**Acceptance (falsifiable).** A pure `sim` module (`trim.ts` + candidates) with tests: a rigged
deck that carries a dead card (a basic land of an off colour, or a 7-drop in a 20-land aggro deck)
is reduced by exactly that card first; a round with no improvement returns the edge candidate;
the mana prior nominates a land after k nonland cuts. The web panel drives the workers through the
existing protocol (one new request kind), shows the round table, Apply works (the deck changes and
the Lab re-reads it), and auto mode reaches the target on the rigged deck. Board row, DESIGN section,
changelog row (`kind: 'app'`).

**Owns:** `packages/sim/src/trim*.ts` (+tests), `apps/web/src/components/lab/TrimPanel.tsx` (+css,
+tests), `apps/web/src/lib/lab/trim*.ts`. **Additive:** `packages/sim/src/index.ts` (exports),
`apps/web/src/lib/sim-protocol.ts` (one request/result kind), `apps/web/src/lib/sim.worker.ts` and
`sim/run.ts`/`plan.ts` (dispatch of the new kind), `apps/web/src/views/LabView.tsx` (mount the
panel), `lab-config.ts` (settings). **Off-limits:** `suggest*.ts` internals beyond re-exporting
what trim needs (extract a shared helper if two copies would otherwise exist).

## Lane M — MANABASE experiments — `feat/lab-manabase`

**What it is.** A Lab mode: *"try other manabases"*. Variants of the hero deck that differ ONLY in
lands, evaluated with the same paired A/B machinery, ranked by win rate AND by reliability:
- land COUNT sweep: base−2 … base+2 lands, the nonland slots filled/cut by the trim/suggest
  machinery's neutral choice (cut the lowest-ranked nonland; add a copy of the most-played one) —
  or, simpler and honest, count variants that swap a basic for the deck's cheapest nonland and back;
- colour MIX sweep: for a two-colour deck, basics ratio ±1, ±2 (Forest↔Plains);
- land TYPE swaps: playable duals from the pool that fit the deck's colours (shocklands, checklands,
  fastlands, taplands …) replacing basics one cycle at a time.

**Reliability metrics**, measured per game from the events the sim already emits or can cheaply
observe: mulligan rate; games with a missed land drop on turns 2–4; games where a spell in hand was
uncastable for colour on turn ≥ 3 ("colour screw"); average lands by turn 4. Reported beside the win
rate, with CIs. A variant "performs better and more reliably" when both move the right way; the
panel shows both and does not collapse them into one number.

**Acceptance.** Pure `sim` module (`manabase.ts` + metrics) with tests: the variant generator's set
for a known deck is exactly the enumerated list; the reliability metrics are read off a scripted
game with known values; a deck rigged to 15 lands is reported less reliable than its 24-land
variant. The web panel runs the sweep through the workers, shows a table (variant, Δ win rate, CI,
mulligans, missed drops, colour screw), and Apply replaces the hero deck's lands. Board row, DESIGN
section, changelog row.

**Owns:** `packages/sim/src/manabase*.ts` (+tests), `apps/web/src/components/lab/ManabasePanel.tsx`
(+css, +tests), `apps/web/src/lib/lab/manabase*.ts`. **Additive:** the same shared files as lane T —
coordinate: each lane adds ITS OWN request kind and ITS OWN panel mount line; do not reformat those
files.

## Lane C — INFINITE COMBOS — `feat/infinite-combos` (design first, then stages)

**Stage 1 — detection and the prompt.** Core already detects LOOPS for CR 104.4b draws (§3.140):
a repeated state signature. Extend that seam: when the same *sequence of player actions* returns
the game to a state that differs from the earlier one only in a MONOTONE resource (life, tokens of a
kind under one control, counters on a set of permanents, damage dealt to a player, cards drawn,
mana in pool), the engine raises a **combo choice** to the acting player: *repeat N times* (N up to
`COMBO_REPEAT_CAP`, a named constant) or *repeat infinitely* or *stop*. A loop with NO net change
(tap A to untap B, tap B to untap A) is not offered — it is the 104.4b draw as today. The
detection is pure and tested on scripted sequences.

**Stage 2 — infinity as a value.** Life, a token cohort, a counter count and "damage dealt" gain an
`Infinity`-capable representation with ONE rule table for arithmetic (∞ − finite = ∞; ∞ − ∞ is
never computed — the engine refuses the symmetric case and says so). Infinite damage to a player
kills them unless a replacement/prevention says otherwise (the same funnel as today). Infinite
life shows ∞. Stage 2 lands with the visual representation in the Play board.

**Stage 3 — cohorts.** An infinite token cohort is ONE battlefield object with a count of ∞ and
"detach X" batching (attack with X of them, tap them all, sacrifice X) — the remainder stays ∞.
Creatures with ∞ counters print ∞/∞. Every choice that enumerates permanents handles a cohort as
one option with a count.

**Acceptance per stage** is written in the stage's DESIGN section before the code; stage 1 is the
first PR. **Owns:** `packages/core/src/combo*.ts`, the Play prompt component for the combo choice,
`apps/web/src/components/play/ComboPrompt.tsx`. **Additive:** the engine's loop seam
(`loop-runaway` / 104.4b path), `GameState` (a `comboWindow` field, cloned in `clone.ts`),
`GameAction` (`repeatCombo`).

## Lane F — the gathered feedback — `feat/feedback-2026-09`

90 bug-report bundles sit in `~/Downloads/bugreport_*.zip` (2026-08-19 → 2026-09-18); 30 are the
reporter's own VERIFY probes and 23 are cited by id in DESIGN/commits. The remaining **37** are
triaged one by one against the LIVE build: reproduce (or find the surface changed), fix, cite the
report id in the commit and in DESIGN §3.17x's table, or mark *already addressed by §3.N* / *not
reproducible on <sha>* with the evidence. The newest three (2026-09-17/18: the Play-board clutter
and the card rules text, the Lab list collapse under debug capture, the duplicate rules text in the
deck builder) go first. **Owns:** whatever each fix needs, one commit per report id.

## Status (kept current by the integrator)

- 2026-09-19 20:15 UTC — Lanes T and M dispatched to worker agents on `jb-trim` / `jb-manabase`
  (forked from 1466d42). Lane F in progress on `jb-feedback` (four FIXED, the triage table in
  §3.176's draft). Lane C brief written (`brief-combos.md`), dispatch when a worker slot frees.
- ⚠️ **GitHub Actions is refusing every job** since ~20:00 UTC: *"recent account payments have failed
  or your spending limit needs to be increased"*. CI and the Deploy PWA workflow are both dead until
  the account's billing is fixed (Caleb). PR gates are being run LOCALLY (`sixrows-verify.ps1`: the
  root verify unpiped, exit codes printed) and quoted in the merge; nothing can go live meanwhile.
  `verify.yml` was also split into `gate` + a 3-shard `tests` matrix on `feat/six-rows`, because the
  single job had started hitting its 30-minute ceiling on `main`.
