# Watch a Game, and teaching the pilot to play better (§WATCH)

> **Status: durable reference. NOT STARTED** (except WATCH-2, which is FIXED on a branch — see below).
> Raised by Caleb on **2026-09-14**. Single source of truth for this scope.
> **Do not re-scope from memory.**

## 0. The requests, verbatim

> Oof - the "Watch a Game" tab has a completely different layout from playing vs an AI - why? It
> should be the same as when you play against an AI - and you should be able to free-swap between
> perspectives of one player vs the other as a silent observer. Or choose to ride along with the
> perspective of whoever's turn it is. Also, I just watched Selesnya Blink play against the red aggro
> deck and it didnt play at all how I would have and it lost where I would have won... So I think
> there are some issues here... How do we proceed? If I could play using that same seed, I could show
> you how I'd play and win? But how to turn that into reusable rules so AIs can play better?

> Bad bug - I cannot select attacker cards so I can therefore not block.

> Also when you watch a game, you should be able to choose the seed if you want

> Also, 'watch a game' should default to games that do not provoke a mulligan from either player
> since those are already less likely to be a good representation of the game.

> we are getting some overriding overlays in app that look bad - like 'heres what goblin guide
> revealed from your library' and 'heres what the computer casted' - those should reconcile somehow

---

## WATCH-1 — one board, three perspectives

### MEASURED 2026-09-14: it is a THIRD board, and that answers the “why?”

`MatchView` → `components/match/MatchReplay.tsx`, which imports **its own
`components/match/PermanentTile.tsx`** — not `play/BoardPermanentTile` — and lays out with its own
`.replay-*` classes. So the app has THREE battlefield renderers: `PlayBoard` (hotseat),
`OnlineBoard`, and this. The first two were unified behind `BoardScene` in §11; the watch tab was
not, because it predates it and nobody looked.

That is the whole explanation for “completely different layout — why?”, and it is the same DRY
failure §11 fixed, one surface over. It also means **every visual item this branch shipped is absent
here**: no tilt, no midline, no advance, no fiery arcs, no damage animation, no card faces with
provenance — none of it, because none of it lives in `MatchReplay`.


The watch tab renders its own layout. That is the **third** board in this app, after the hotseat and
online boards — and §11's whole lesson was that two boards drifting is a DRY failure that costs
features silently (the online board could not show an advance for months because nobody noticed).

`BoardScene` now exists precisely so a battlefield is drawn in ONE place. The watch tab should mount
it like the other two, parameterised by the same props. **Do not port features to a third
composition.**

Perspectives, all three of which Caleb named:
- **Seat A** as a silent observer
- **Seat B** as a silent observer
- **ride-along** — follow whoever's turn it is

The view-model already masks by seat (`buildBoardView(state, viewer)`), so a perspective is an
argument, not a feature. ⚠️ A spectator is NOT a seat: decide deliberately whether an observer sees
hidden hands (it is a replay of a finished game, so the honest answer is probably yes, with it
LABELLED) — and whatever is decided, it must be one rule, stated, not an accident of which mask the
watch tab happens to pass.

## WATCH-2 — "I cannot select attacker cards so I cannot block" — **FIXED, unmerged**

Found independently by the online-event-stream work, which is the same defect:

> `OnlineBoard` derived eligible blockers from the server's `declareBlockers` template, which is
> core's **baseline** and carries `blocks: []` by design. So the set was empty in every real block
> window — a defending seat's only button was ever "No blocks".

Fixed on `feat/online-event-stream` by sharing the hotseat's own `eligibleBlockerIds`
(`view-model.ts`), with the engine still the authority at submit. **Eighth "green and unreachable"
item on this branch**: the §11 parity test was green throughout because it tested *drawing* a block
from a hand-built `CombatState`, never *making* one.

### A THIRD possibility, found while measuring WATCH-1

**A replay has no interaction at all.** `MatchReplay` renders a finished game with
`PlaybackControls`; there is nothing to click and no seat to act for. So if Caleb was in the WATCH
tab when he wrote “I cannot select attacker cards”, the app was behaving correctly and the defect is
that it looks like a game you could act in. A spectator surface that is indistinguishable from a
playable one is a UX bug in its own right, whatever the answer here turns out to be.

So there are three candidates and they need telling apart before this is closed:
1. the ONLINE empty-blocker set (fixed, merged — the leading candidate),
2. a HOTSEAT block window (checked: `verify-combat-visibility` passes 6/6 driving a real game to a
   confirmed block, and the interaction code marks the opponent's attackers selectable — so this is
   the least likely),
3. the WATCH tab, where it is correct behaviour presented confusingly.

⚠️ **Verify Caleb's report is this same bug and not a second one.** His report does not say whether
he was online or in a hotseat game. If a HOTSEAT block window also refuses to select attackers, that
is a different defect and this fix does not cover it — check before closing.

## WATCH-3 — choose the seed, and prefer no-mulligan games

- **Choose the seed.** The engine is deterministic in (seed, decklists, actions) — that property is
  load-bearing across the sim, the replay and forking — so replaying an exact game is a matter of
  surfacing the seed, not building anything.
- **Default to games neither player mulliganed**, because a mulligan game is a less representative
  sample. Cheap to detect: the mulligan transcript is already part of `PlayRecord`.
  ⚠️ **Default, never a filter that hides the rest** — a suppressed game is exactly the "silent
  approximation" rule 2 forbids. Say how many were skipped and offer them.

## WATCH-4 — overlapping overlays

> 'heres what goblin guide revealed from your library' and 'heres what the computer casted'

`RevealBanner` and the spell hold are **independent announcers** that can occupy the screen at once,
and neither knows about the other. So is the combat-hold banner, and so is the auto-settled-choice
announcement currently being built — that makes **four** things that announce.

**The fix is a queue, not four z-indexes.** One announcement surface with a closed table of kinds,
each row carrying its priority and duration; announcements queue rather than stack, and a
lower-priority one waits. This must be built as the shared mechanism *now*, before the fourth
announcer lands and makes it five.

---

## WATCH-5 — "it lost where I would have won" — how to turn play into rules

This is the substantial one, and it deserves a straight answer rather than a feature.

### The honest framing

"Play the seed myself and show you" is a good instinct and **already possible**: the engine is
deterministic in (seed, decklists, actions), `PlayRecord` captures exactly that, and forking a game
at turn *k* is already a shipped feature. So Caleb can replay the same game and play it his way.

But a single game proves very little. This project already knows why, and paid for it: §3.82's
finding that **a single-seed A/B reports flukes** is the reason the two-seed protocol and the Pocock
sequential boundaries exist. One won game where the pilot lost is an anecdote; the pilot's strength
is a distribution.

### What a divergence IS good for

Not "the pilot was wrong here, hard-code this." It is good for finding the **decision class** the
pilot is blind to — which is exactly how the Fatal Push finding worked (`AI-CONDITIONAL-REMOVAL.md`):
one observed mistake, generalised to "conditions checked at RESOLUTION are invisible to a
legality-driven chooser", then fixed as a class with a guard.

So the workflow, and it is already mostly built:

1. **Capture the divergence.** Fork the game at the turn in question, play it Caleb's way, and diff
   the two action logs. The first differing decision is the candidate.
2. **Name the class**, not the move. "Blink the Priest before blockers" is a move; "the pilot does
   not value an ETB it can re-trigger" is a class.
3. **Measure it** across many seeds before building. `suggest`/`swap` already run paired games with
   honest statistics — the same harness answers "does teaching the pilot this actually win more
   games?" A change that does not move the number is not an improvement, however obviously right it
   looked in one game.
4. **Ship it with the behaviour lock reviewed.** `selfplay-lock.test.ts` pins seeded outcomes; a
   genuine pilot improvement WILL move them, and that diff is inspected deliberately.

### What to build to make that loop usable

The missing piece is not AI rules — it is the **divergence tool**: from a watched or finished game,
"play from here myself", then a readable diff of my line versus the pilot's, and a one-click
"measure this change across N seeds". Everything under it exists (forking, paired sims, sequential
stopping); nothing joins them into a loop a person can run.

⚠️ **Resist encoding Caleb's line as a rule directly.** A pilot taught to reproduce one human game is
overfitted to one shuffle. The pilot's own program (`jonny-boi-superhuman-ai-program`) is a
heuristic+search player; the durable form of "I would have won" is a better EVALUATION TERM or a
better search, measured — not a scripted line.
