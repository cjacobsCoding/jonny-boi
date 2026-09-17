# Caleb's physical decks

**TWO** real decks, read from phone photos on **2026-09-14** after the app lost their imported
copies (see [PLAY-HISTORY-AND-STORAGE.md](../PLAY-HISTORY-AND-STORAGE.md) §1 for why). Kept here so
they survive whatever the browser's storage does.

⚠️ **GET THE NAMES RIGHT — they have been wrong twice and it cost real time.** Caleb named each of
these; none of the names were mine to invent:

| deck | what it is | the tell |
| --- | --- | --- |
| **Thune's Life** | green/white lifegain | Archangel of Thune, Soul Warden, Rhox Faithmender |
| **Tamiyo + Jace Surge** | blue/green defenders ramp | the two planeswalkers it is named for |

The photo deck now called `thunes-life.txt` was filed as "Acidic Angels" for a day, which made
"Acidic Angels is complete" read as an answer about the wrong deck.

## ⚠️ ACIDIC ANGELS IS NOT IN THIS DIRECTORY, AND MUST NOT COME BACK

**He already owns it.** Caleb scanned that deck long ago; the app filed it under the name of the
BUILT-IN deck it resembles, *"Selesnya Blink (scanned)"*; he renamed it to **Acidic Angels**; and
that rename is what surfaced the built-in-fork bug (DESIGN §3.35). His copy — the correct, 60-card
one — lives in his browser's own deck storage and nothing in this repo can reach it.

For one revision this directory ALSO held a 59-card `acidic-angels.txt`, transcribed from the scan,
and the app seeded it as a second deck of that name. Told the seed had been deleted, his reply was:

> *"You say Acidic Angel deck is gone - but its not and dont scare me like that - because the
> correct 60 card version of it was already in my decks."*

So: the transcription is deleted, the registry row is gone, and two guards stand where it was.
`packages/sim/src/owner-decks.test.ts` fails if the name — or its card list under another name —
reappears in the registry, and `apps/web/src/lib/decklist/paperDecks.ts` refuses to seed **any**
deck whose name he is already using, leaving his untouched. The `RENAMED_COPY = 'Acidic Angels'`
constants in `apps/web` still refer to the §3.35 story and are correct; they are about HIS deck.

## These lists are in the app, in his ONE collection

✅ **There is nothing to paste** (DESIGN §3.157). Each list is a data file in
`packages/sim/data/owner-decks/`, and on a profile that has not been given it yet the app SEEDS it
as an ordinary deck of his own — listed under **Your decks** with everything he built by hand, and
editable exactly like them.

They are not a separate kind of deck, and the region that made them one is gone:

> *"yo why is there a 'your paper decks' and 'your decks' - this is dumb. I just want one collection
> of decks and I must be able to edit all of them, regardless of whether scanned in."*

Seeding happens **once per profile** and is **add-only**: it never removes, renames, merges or
overwrites a deck he has, and a deck he deletes stays deleted. Once seeded, the deck is his — this
file stops being its source of truth and his copy is the deck.

⚠️ **These `.txt` FILES ARE STILL THE SOURCE OF TRUTH FOR THE SEED.** Correct a name or a count
HERE; `packages/sim/src/owner-decks.test.ts` re-reads these files and fails if the shipped registry
has drifted from them by so much as one copy, so the two cannot answer differently. A correction
reaches a profile that has already been seeded only through his own editing — which he can now do,
which is the point.

Pasting a list into **Deck Builder → Import** still works, and is how you would bring in a deck that
is not one of these — the parser accepts this plain `4 Card Name` format, and every other mainstream
export flavour besides.

## One of the two is complete

Checked against the real compiled pool, not assumed. The campaign is closing this gap card by card
(`docs/ALL-CARDS-CAMPAIGN.md` §7a is the live board):

| deck | distinct names | cards | blocked when transcribed | blocked now |
| --- | --- | --- | --- | --- |
| Thune's Life | 22 | 65 | 8 | **0** ✅ |
| Tamiyo + Jace Surge | 17 | 49 | 9 | **5** (in the shipped pool) |

✅ **THUNE'S LIFE COMPILES END TO END** — every name in it resolves, and it seeds at its full 65
cards.

⚠️ **TAMIYO + JACE SURGE IS 49 CARDS AS TRANSCRIBED, WHICH IS SHORT OF 60, AND THAT IS NOT A BUG.**
The names are read off the physical cards and the counts are inferred from sleeve depth (see
*Confidence* below), so the app ships the deck it was told about rather than inventing eleven cards
Caleb does not own. An earlier revision hid this behind a special legality rule — `ownerDeckRules`
set a paper deck's legal minimum to its own transcribed size, so 49 could report itself "legal".
That rule is retired. The deck is judged by the same constructed rules as any deck he builds, its
row says plainly that it is short, **and he can now simply fix it, because the deck is editable.**

⚠️ **The "blocked now" column measures the SHIPPED POOL, and the compiler runs ahead of it.** Tamiyo,
Jace, Primal Surge, Craterhoof Behemoth and Axebane Guardian all have compiler work landed or in
flight (§3.154–§3.156); the pool the app carries was regenerated 2026-09-15 and does not have all of
them yet. The app prints **its own** number in the deck row rather than trusting this table, and
`paperDecks.ts` folds each name into the deck automatically the moment the pool learns it — so this
row moves at the next regeneration, with nothing to update by hand.

Until a list is clean, the deck in the app is missing part of its identity — and it SAYS SO, in its
own row, naming every card the pool cannot supply and how many cards of the deck they cost, because
a deck that resolves to a handful of lands is not a deck. (Importing a list by hand reports the same
thing as a "not found" count in the import dialog.)

Both lists are **2012–2013 Standard** (Return to Ravnica / M13 / Innistrad / Avacyn Restored). The
pool has some of that era — Angel of Serenity, Thragtusk, Restoration Angel, Cloudshift, Conjurer's
Closet, Acidic Slime, Temple Garden and Sunpetal Grove are all present — so this is a curated gap,
not a clean cutoff. Each list marks its missing cards.

## Confidence

Card NAMES are read from the photos and then verified to exist (or not) in the pool, so a name here
is either a real card or a flagged miss — not a guess that silently became a decklist. **COUNTS are
inferred** from sleeve-edge depth; the mana bases are the least certain part, and one deck does not
reach 60. Correct them freely — that is what a decklist file is for, and correcting the deck in the
app is now just editing it.
