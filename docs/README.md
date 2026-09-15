# The request ledger

Every outstanding request Caleb has made, recorded verbatim with what was MEASURED about it before
any design was written. **These files are the source of truth for scope — do not re-scope from
memory, and do not carry a request in a session.**

Three of these were nearly lost: they were written to a session scratchpad rather than the repo, and
a session scratchpad does not survive the session. That is the whole reason this index exists.

| file | covers | status |
| --- | --- | --- |
| [ALL-CARDS-CAMPAIGN.md](ALL-CARDS-CAMPAIGN.md) | **every MTG card playable** — the measured baseline, the mandated phase order, the acceptance board for Caleb's own decks (§7a), and what four completed lanes proved (§8a) | active — phase 2, +310 cards, 6 of 16 deck cards unblocked |
| [decks/](decks/) | Caleb's two physical decks, transcribed from photos, with per-card blocked/unblocked state | 10 of 16 still blocked |
| [MTGA-UX-OVERHAUL.md](MTGA-UX-OVERHAUL.md) | the play surface — UX-1…UX-30, §9 zones-as-piles, §10 the combat hold, §13 prompt polish | 17 shipped, UX-18…30 open |
| [WATCH-A-GAME.md](WATCH-A-GAME.md) | the watch tab, its layout and perspectives, the seed, overlapping overlays, and how a human's better line becomes a pilot improvement | open (WATCH-2 fixed, unmerged) |
| [SUGGEST-THEMES.md](SUGGEST-THEMES.md) | Lab → Suggest: deck themes, building out from a 2-card seed, mana bases | open |
| [DECKBUILDER-AND-ART.md](DECKBUILDER-AND-ART.md) | preferred card art with a per-deck override, mobile deck building, the builder's UX | open |
| [PLAY-HISTORY-AND-STORAGE.md](PLAY-HISTORY-AND-STORAGE.md) | the game library pushing the page down, filter/search — **and the storage budget that probably ate two imported decks** | open |
| [END-OF-GAME.md](END-OF-GAME.md) | games ending abruptly, negative life, an after-match stats screen | open |
| [AI-CONDITIONAL-REMOVAL.md](AI-CONDITIONAL-REMOVAL.md) | the pilot aiming Fatal Push where it cannot kill | open |
| [OFFLINE-AND-DISTRIBUTION.md](OFFLINE-AND-DISTRIBUTION.md) | offline on PC and mobile, Android builds, Fleet, the update button, bug reports to the NAS | open, 3 blocking unknowns |

## What every file in here does

Each records the request **verbatim** first, then what was measured about the code before proposing
anything — because on this project the measurement has repeatedly changed the shape of the work:

- half of the "suggest by theme" request was **already shipped** (role gaps);
- the per-deck art override **already existed**, leaving only a global layer and a precedence rule;
- negative life is **already tracked** — core never clamps it, the end screen just shows no life;
- and the game library is allowed **4 MB of a ~5 MB localStorage budget**, which is the leading
  explanation for two imported decks vanishing.

⚠️ **One line here was itself wrong and is corrected in place** rather than quietly deleted, because
the failure is instructive. This index used to say *"the deck builder has no mobile layout at all,
not a bad one."* It does have one — `@media (max-width: 860px)` in `apps/web/src/styles.css` covers
`.deck-layout` and `.deck-panel`. The sweep that "proved" the absence searched for `deck-builder` and
`builder__`, which are not the class names. **A search for the wrong name returns exactly what a
genuine absence returns**, so a negative finding is only as good as the name it searched for. The
real request is in [DECKBUILDER-AND-ART.md](DECKBUILDER-AND-ART.md) §2.0.

## The standing lesson these all inherit

Nine times now on this surface, work has been **built, tested, green, and unreachable by a player**.
Every one was caught by running a browser harness or opening a screenshot — never by a test. So each
file states how its acceptance is to be PROVEN, and "the suite is green" is never the answer.
