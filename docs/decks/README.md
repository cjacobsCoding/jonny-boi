# Caleb's physical decks

**THREE** real decks. Two were read from phone photos on **2026-09-14** after the app lost their
imported copies (see [PLAY-HISTORY-AND-STORAGE.md](../PLAY-HISTORY-AND-STORAGE.md) §1 for why); the
third was scanned earlier and, until 2026-09-15, existed only inside a test fixture. Kept here so
they survive whatever the browser's storage does.

⚠️ **GET THE NAMES RIGHT — they have been wrong twice and it cost real time.** Caleb named each of
these; none of the names were mine to invent:

| deck | what it is | the tell |
| --- | --- | --- |
| **Acidic Angels** | the FIRST deck scanned in | Acidic Slime + Angel of Serenity |
| **Thune's Life** | green/white lifegain | Archangel of Thune, Soul Warden, Rhox Faithmender |
| **Tamiyo + Jace Surge** | blue/green defenders ramp | the two planeswalkers it is named for |

The photo deck now called `thunes-life.txt` was filed as "Acidic Angels" for a day, which made
"Acidic Angels is complete" read as an answer about the wrong deck.

⚠️ **There is exactly ONE Acidic Angels, and it is the deck in the fork-bug story.** Caleb scanned
it; the app filed it under the name of the BUILT-IN sample deck it resembles, *"Selesnya Blink
(scanned)"*; he renamed it to its real name, **Acidic Angels**; and that rename is what surfaced the
built-in-fork bug (DESIGN §3.35). The list below, the §3.35 story, and the `RENAMED_COPY = 'Acidic
Angels'` constants in `apps/web` are **all the same deck**. An earlier version of this file claimed
they were two decks that happened to share a string. They are not, and reading it that way is what
made the correction take three rounds.

✅ **THESE LISTS ARE NOW IN THE APP — there is nothing to paste** (DESIGN §3.153). Each one is a
data file in `packages/sim/data/owner-decks/`, listed in the Deck Builder under **Your paper
decks** and offered in every deck picker, so you can open or play one straight from a cold start.

⚠️ **THESE `.txt` FILES ARE STILL THE SOURCE OF TRUTH.** Correct a name or a count HERE;
`packages/sim/src/owner-decks.test.ts` re-reads these files and fails if the shipped registry has
drifted from them by so much as one copy, so the two cannot answer differently. What the registry
must NOT do is diverge silently, which is why the guard exists rather than a comment asking nicely.

Pasting a list into **Deck Builder → Import** still works, and is how you would bring in a deck
that is not one of these three — the parser accepts this plain `4 Card Name` format, and every
other mainstream export flavour besides.

## Two of the three are complete

Checked against the real compiled pool, not assumed. The campaign is closing this gap card by card
(`docs/ALL-CARDS-CAMPAIGN.md` §7a is the live board):

| deck | distinct names | blocked when transcribed | blocked now |
| --- | --- | --- | --- |
| Acidic Angels | 16 | — | **0** ✅ |
| Thune’s Life | 22 | 8 | **0** ✅ |
| Tamiyo + Jace Surge | 17 | 9 | **5** |

✅ **ACIDIC ANGELS and THUNE'S LIFE both compile end to end** — every name in each imports as the
deck Caleb actually built. **Tamiyo + Jace Surge is the one still short**, at 5 of 17 names: Axebane
Guardian, Craterhoof Behemoth, Primal Surge, and the two planeswalkers the deck is named after.

⚠️ **Jace and Tamiyo were filed as evidenced NO-GOs, and that reads very differently now.** A card
whose residue is named and pinned is a fine outcome for a card nobody asked about — it is not a fine
outcome for the two cards a deck is named after. Their residues are in §7a; the families that hold
them are the work, not the cards.

Until a list is clean, the deck in the app is missing part of its identity — and it SAYS SO, in its
own row, naming every card the pool cannot supply and how many cards of the deck they cost. It also
refuses to start a game rather than shuffling up what is left, because a deck that resolves to a
handful of lands is not a deck. (Importing a list by hand reports the same thing as a "not found"
count in the import dialog.)

⚠️ The table above is measured against the COMPILER; the pool the shipped app carries can lag it,
so a deck can read as clean here and still be short in the app until the next regeneration. On the
pool as regenerated 2026-09-15 the app resolves **Acidic Angels 16/16, Thune's Life 22/22 and
Tamiyo + Jace Surge 12/17** — the app is caught up with this table, and it always prints its own
number in the deck row rather than trusting this one.

✅ **Two of the three are PLAYABLE end to end today.** Acidic Angels deals its 59 cards and Thune’s
Life its 65; Tamiyo + Jace Surge refuses, by name, for all five cards it is still missing.

All three lists are **2012–2013 Standard** (Return to Ravnica / M13 / Innistrad / Avacyn Restored). The
pool has some of that era — Angel of Serenity, Thragtusk, Restoration Angel, Cloudshift, Conjurer's
Closet, Acidic Slime, Temple Garden and Sunpetal Grove are all present — so this is a curated gap,
not a clean cutoff. Each list marks its missing cards.

## Confidence

Card NAMES are read from the photos and then verified to exist (or not) in the pool, so a name here
is either a real card or a flagged miss — not a guess that silently became a decklist. **COUNTS are
inferred** from sleeve-edge depth and balanced to a legal 60; the mana bases are the least certain
part. Correct them freely — that is what a decklist file is for.
