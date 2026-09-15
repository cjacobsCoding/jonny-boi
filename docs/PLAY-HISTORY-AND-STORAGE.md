# The game library, and the storage budget it eats (§HIST)

> **Status: durable reference. §1 SHIPPED (`fix/storage-honesty`). §2 and §3 NOT STARTED.**
> Raised by Caleb on **2026-09-14**, alongside a separate report that two imported decks had
> vanished. **Those two are probably the same bug**, and that is the main finding in this file.
> Single source of truth for this scope. **Do not re-scope from memory.**
>
> What §1 landed, so nobody re-derives it: one write funnel (`lib/persistence/write.ts`) every
> Web-Storage write goes through, returning a result instead of `void` and raising the user-facing
> notice itself; one budget table (`lib/persistence/budget.ts`) that owns the origin's allowance and
> divides it, with `PLAY_HISTORY_LIMIT` now DERIVED from it rather than being a second, disagreeing
> answer; a storage readout on the About page; and an app-shell banner that says a save failed at
> the moment it fails. The 4,000,000-character history cap is now a READ ceiling only — see the
> warning in `config.ts` for why lowering it would have destroyed the libraries already on disk.
>
> The budget shares came from measurement, not intuition:
> `node apps/web/scripts/measure-storage-budget.mjs` plays real games and encodes them exactly as
> `persist.ts` does. One record is **27,710 characters mean, 47,341 max**, so a 50-game library is
> ~1,385,500 — 55% of the whole origin. Re-run it before moving any share.
>
> §2 (HIST-1, the library must not push the page down) and §3 (HIST-2, filter and search) are
> untouched and still describe work to do.

## 0. The request, verbatim

> games you played previously should not just infinitely push all other content further down the
> page as the list grows lol - it should be like a sub tab or something - the current UX is
> laughable. And I should be able to filter through and search the games played.

And, separately, the same day:

> I dont see the two recent decks I imported into jponny boi and I don't know why?

## 1. ⚠️ THE TWO REPORTS ARE PROBABLY ONE BUG

### 1.1 The numbers

- `PLAY_HISTORY_LIMIT = 50` — fifty games kept (`config.ts:112`).
- **`PLAY_HISTORY_MAX_CHARS = 4_000_000`** — the history is permitted **four million characters** of
  localStorage (`config.ts:120`).

A browser's localStorage budget is **per origin**, and typically around 5 MB. So the game library
alone is allowed to claim roughly **80% of the entire budget**, and it shares that origin with:

- saved decks (`jonny-boi.decks.v1`)
- the in-progress game (`jonny-boi.play.inProgress.v1`)
- TTL-cached Scryfall printings (the alternate-art cache)
- bug-report clips, which capture **full DOM snapshots** (the bug-reporter harness measured 86,781
  nodes in one page)

### 1.2 Why that loses decks SILENTLY

`storage.ts`:

```js
export function saveDecks(decks) {
  try { localStorage.setItem(DECKS_STORAGE_KEY, JSON.stringify(decks)); }
  catch (error) { console.warn('Could not save decks to localStorage.', error); }
}
```

A quota failure is **swallowed into a console warning**. The deck is in React state, so it appears
in the session and is gone on the next load. That is precisely the reported symptom: *"I imported
two decks and I don't see them."*

The deck storage KEY has not changed since the original commit (`git log -S DECKS_STORAGE_KEY`
returns only `7c01e64`), so this is not a migration wiping them — which makes the quota path the
leading explanation.

### 1.3 What to fix, as a class

1. **No silent persistence failure, anywhere.** `saveDecks` must report failure to its caller, and
   the UI must say so *at the moment of the save*, not leave the user to discover it on reload. Sweep
   for the siblings: every `catch` in `storage.ts`, `persist.ts` and `history.ts` that swallows a
   write. This is rule 1 — fix the shape, not the instance — and rule 60: a fallback must REPORT
   that it fired.
2. **Budget the origin, not each consumer.** Four separate features each sized against "5 MB" will
   always overcommit. There should be ONE place that knows the budget and how it is divided, and the
   history's 4,000,000 is the first row to revisit. A 50-game library of full action logs is a
   research tool; it should not be able to cost a user their decks.
3. **Make it visible.** A storage-usage readout (what is stored, how big, what can be cleared)
   turns an invisible failure into a thing the user can act on.
4. **The guard**: a test with a stubbed storage that rejects on quota, asserting a visible error
   surfaces rather than a console line — and that the deck is not reported as saved. `storage.test.ts`
   already stubs storage ("survives storage that refuses to write"), so the seam exists; today it
   asserts the *absence of a crash*, which is not the same as the presence of a warning.

## 2. HIST-1 — the library must not push the page down

`GameLibrary.tsx` renders `rows.map(...)` with **no `slice`, no `max-height`, no `overflow`** — an
unbounded list, up to `PLAY_HISTORY_LIMIT` (50) rows, inline in the Play view. Every finished game
pushes everything below it further down. Caleb's word for it is "laughable" and the code agrees.

**The fix Caleb named** — make it its own sub-tab / panel rather than an inline list — is also the
right one structurally: the library is a *browsing* surface, not part of the play surface's primary
flow. It should be reachable, scrollable within its own bounds, and cost the Play view zero vertical
space when you are not looking at it.

## 3. HIST-2 — filter and search the games played

Needed at minimum, because they are the questions actually asked of a game library:

- by **outcome** (win / loss / draw / unfinished)
- by **deck** — yours and the opponent's
- by **date**
- free-text over deck names
- and, since this is a deck-tuning lab: by whether the game belongs to a **suggest run** or an
  A/B arm, so a session's games can be found as a group

The data is already there: a `HistoryEntry` carries `outcome`, `createdAt`/`updatedAt`, `parentId`
and the full `PlayRecord` with both decklists, so none of this needs new storage — only an index and
a filter over what is already persisted.

⚠️ Do the filtering over the **decoded index, not the raw blob**: decoding 50 full action logs to
answer "which of these did I win?" would make the list slow exactly as it grows, which is the
failure mode this section exists to remove.
