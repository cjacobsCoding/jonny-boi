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
"Acidic Angels is complete" read as an answer about the wrong deck. And `acidic-angels.txt`'s own
list was imported by the scanner as *"Selesnya Blink (scanned)"* — after a BUILT-IN sample deck it
resembles — which is how the built-in-fork bug (DESIGN §3.35) was found in the first place.

Paste either list into **Deck Builder → Import** — the parser accepts this plain `4 Card Name`
format, and every other mainstream export flavour besides.

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

Until a list is clean, importing it produces a deck with part of its identity missing — worth knowing
before blaming the importer: the import dialog reports a "not found" count, and a deck that
resolves to a handful of lands is not a deck.

All three lists are **2012–2013 Standard** (Return to Ravnica / M13 / Innistrad / Avacyn Restored). The
pool has some of that era — Angel of Serenity, Thragtusk, Restoration Angel, Cloudshift, Conjurer's
Closet, Acidic Slime, Temple Garden and Sunpetal Grove are all present — so this is a curated gap,
not a clean cutoff. Each list marks its missing cards.

## Confidence

Card NAMES are read from the photos and then verified to exist (or not) in the pool, so a name here
is either a real card or a flagged miss — not a guess that silently became a decklist. **COUNTS are
inferred** from sleeve-edge depth and balanced to a legal 60; the mana bases are the least certain
part. Correct them freely — that is what a decklist file is for.
