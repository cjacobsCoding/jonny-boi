# Games end abruptly (§END)

> **Status: durable reference. NOT STARTED.** Raised by Caleb on **2026-09-14**.
> Single source of truth for this scope. **Do not re-scope from memory.**
> Close kin to [PLAY-HISTORY-AND-STORAGE.md](PLAY-HISTORY-AND-STORAGE.md) — both are about looking at
> a game that has finished, and they should share one answer, not two.

## 0. The request, verbatim

> games end so abruptly! I want to see some kind of cool defeat montage.. I want to see the negative
> health if I annihilate them... I want to see an after-match stats screen...

## 1. What is there today

`EndScreen.tsx` is **41 lines**: one emoji (👑 or 🤝), "X wins!", an optional one-line reason, and two
buttons. It does not show the life totals, the turn count, or anything that happened. "Abrupt" is a
fair description of the code, not just the feeling.

## 2. MEASURED: two of the three asks are nearly free

### 2.1 Negative life ALREADY EXISTS in the engine

`packages/core/src/internal/damage-result.ts:86` is `player.life -= amount` — **no `Math.max(0, …)`
anywhere in core**. A player loses to a state-based action at 0 or less, but the life total keeps
going, exactly as real Magic tracks it. So when you swing for 12 into a player on 3, the state
genuinely holds **−9**.

Nothing has to be built to *produce* that number. It simply is not shown: the end screen displays no
life at all. This is the cheapest item in any of the TODO docs, and it is the one with the most
swagger per line.

⚠️ Check on the way through whether any DISPLAY path clamps it (a seat rail, a log line). If one
does, that is a small honesty bug worth fixing in the same pass — the engine is telling the truth and
a clamp would be the UI hiding it.

### 2.2 The stats are derivable from what is already persisted

A finished game is already stored as a `PlayRecord` (seed, both decklists, starting player, the
mulligan transcript, the accepted-action script), and `rebuildFromRecord` replays it deterministically.
The event stream a replay produces carries damage, life changes, zone changes, spells cast and turns.

So an after-match screen needs **no new storage and no new engine hooks** — it needs a FOLD over the
events that already exist. `lib/play/reveals.ts` is the model already in the repo: "a fold over the
events rather than state stored on the board, for the same reason §3.57's animations are — a derived
value cannot go stale, and a replay or a resumed game re-derives the same thing from the same log."

Worth showing, because they answer questions a deck-tuning lab actually asks:
- final life both sides (including a negative one)
- turns played, and who was on the play
- damage dealt by each side, and how much came from combat vs spells
- the biggest single swing
- cards drawn, spells cast, mana spent
- the card that dealt the most damage — the "MVP", which is genuinely useful when tuning a deck

⚠️ **Derive from the event fold, not from a second tally kept during play** (rule 3). A counter
incremented in the UI will disagree with the log the first time a game is resumed or replayed, and
the bug will be blamed on neither.

### 2.3 The "defeat montage" is the only genuinely new work

Deliberately left least specified, because it is the one part where taste matters more than data and
Caleb has not said what he wants beyond "cool". Before building a long cinematic, note what this
project has already learned twice (`MTGA-UX-OVERHAUL.md` §10): **the problem with the end of a game
is not that it lacks animation, it is that it does not HOLD.** The combat hold shipped for exactly
that reason. A montage that cannot be skipped will be infuriating by the fifth game, and this app is
built to play hundreds.

So: make it hold, make it readable, make it **skippable**, and put every duration in `play-config.ts`
as a named constant judged against the existing hold beats.

## 3. The seam it shares with the game library

`PLAY-HISTORY-AND-STORAGE.md` §2-3 wants the game library to become its own sub-tab with filter and
search. An after-match stats screen and a library entry's detail view are **the same view of the same
data** — one reached when a game ends, one reached from a list. Build the fold once and mount it
twice (rule 3). If they end up as two components computing two sets of numbers, they will eventually
disagree about who won.

## 4. Acceptance

- A game that ends with a player on negative life SHOWS that number.
- The stats screen is reachable both at game end and from the library, and both render from the same
  fold.
- Every animation is skippable, and its duration is a named constant.
