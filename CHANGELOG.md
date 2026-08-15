# Changelog — what actually shipped

The user-facing record of every feature that is really in the app, newest first. The
**What's New** tab in the PWA renders this file; it is not a separate list to keep in sync.

## For agents: this file is not optional

Several Claudes work this repo from different machines, so "I'll remember to write it up"
does not survive. Two automated gates make the record self-maintaining, and both live in
`apps/web/src/data/changelog.test.ts`:

1. **Every roadmap feature marked `✅ done` in DESIGN.md §3 must have an entry here**,
   tagged with its section. Flip a feature to ✅ without writing the entry and the suite
   fails, naming the section you skipped.
2. **The bundled `apps/web/src/data/changelog.json` is DERIVED from this file** and the
   test re-derives it, so the app can never drift from what is written here.

Regenerate the bundled copy with `npm run changelog -w @jonny-boi/web` after editing.

Adding an entry is part of the definition of done (DESIGN.md §7), alongside flipping the
§3 status and updating COORDINATION.md.

### Entry format

```
## <YYYY-MM-DD> — <short title, what the USER can now do>
*Roadmap: 3.11*        <- omit this line for work with no roadmap section

Plain-English body. Write for someone using the app, not for the person who wrote it.
```

The `Roadmap:` tag is what gate #1 matches on. Work that is a fix or an improvement rather
than a roadmap feature simply omits it.

---

## 2026-08-15 — The A/B swap picker no longer offers cards the engine can't play

Picking a card the simulator does not implement yet used to fail the run before its first game,
with no indication of which card was at fault (reported for Elvish Visionary → Acidic Slime).
Those cards are still listed — they exist in your collection — but are now greyed out and say
exactly which rules system they are waiting on.

## 2026-08-15 — See everything that has shipped, in the app
*Roadmap: 3.13*

A **What's New** tab listing every feature actually in the build, newest first. The list is
generated from this file and checked by the test suite, so it stays honest no matter which
machine or which agent did the work.

## 2026-08-15 — Imported decks name the card that is holding them up

Watching a game with an imported deck used to fail with `unknown card "<uuid>"` — an id shown
nowhere in the app, leaving you to guess which of sixty cards was the problem. The Lab and the
Match viewer now share one check and both name the cards.

## 2026-08-14 — Deck import understands far more decklist formats
*Roadmap: 3.11*

Paste a list from MTGO, Moxfield, Arena, Archidekt, TappedOut, Deckbox or a plain text file.
Split cards written in full (`Wear // Tear`) now resolve, and so do Universes Beyond printings
whose decklist name differs from the card's catalogue name (`Kavaero, Mind-Bitten` is filed as
*Superior Spider-Man*). Anything genuinely unrecognised is reported with its line number rather
than silently dropped.

## 2026-08-13 — A real app icon

The placeholder is gone, replaced by generated key art that survives being shrunk to a browser
tab. Installs on Android, iOS and desktop with a proper maskable variant.

## 2026-08-12 — Scan a deck from a photo
*Roadmap: 3.12*

Point a camera at a decklist and import it, without typing it out.

## 2026-08-12 — Import any decklist, and know exactly what will not play
*Roadmap: 3.11*

Paste a decklist, a deck URL, or a file and get real cards. Printed rules text is compiled into
genuine engine behaviour, and a card is either fully implemented or reported with the exact
clause and the engine system it still needs — never quietly approximated into a do-nothing card,
because a silently wrong card would poison the A/B verdicts the whole lab exists to produce.

## 2026-08-10 — Pass-and-play on one device
*Roadmap: 3.10*

Two people, one screen, hot-seat.

## 2026-08-08 — Triggered abilities and continuous effects
*Roadmap: 3.9*

The engine handles "when this enters", "whenever that attacks", and effects that keep changing
the board while they are around — the quality gate that makes a simulated result worth trusting.

## 2026-08-05 — A meta gauntlet to test against
*Roadmap: 3.8*

A set of representative opponent decks, so "is my deck better?" is measured against a real field
instead of one matchup.

## 2026-08-02 — The web app
*Roadmap: 3.7*

Deck builder, card browser, the Lab, and a match viewer, as an installable PWA that runs on
desktop, Android and in the browser.

## 2026-07-28 — "Make my deck better"
*Roadmap: 3.6*

Hand the engine a deck and it proposes single-card swaps, plays each one out against the
gauntlet, and ranks them by how much they actually helped — with a significance verdict, not a
vibe. The search is adaptive: cheap scouting rounds eliminate weak candidates so the games get
spent on the finalists.

## 2026-07-24 — Statistically definitive answers
*Roadmap: 3.5*

Headless matches and gauntlets, win rates with confidence intervals, and a paired A/B swap test
that tells you whether a change is genuinely better, worse, or too close to call at N games.

## 2026-07-20 — AI pilots that play the decks
*Roadmap: 3.4*

A heuristic pilot good enough to pilot the meta decks competently, plus a look-ahead search
pilot available as a research option.

## 2026-07-16 — Real cards and real art
*Roadmap: 3.3*

Card data and artwork from Scryfall, cached locally so the app works offline and never waits on
the network mid-game.

## 2026-07-12 — Cards as data
*Roadmap: 3.2*

A card is a data record referencing small composable effects, so adding a card is a data edit
rather than an engine change.

## 2026-07-08 — The rules engine
*Roadmap: 3.1*

Turns, phases, priority, the stack, mana, casting, combat, state-based actions, and winning or
losing — deterministic from a seed, so a result can be reproduced exactly.

## 2026-07-04 — Project foundation
*Roadmap: 3.0*

The monorepo, build, and test tooling everything else is built on.
