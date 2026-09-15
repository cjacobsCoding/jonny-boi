# The deck builder, and preferred art (§DB)

> **Status: durable reference. NOT STARTED.** Raised by Caleb on **2026-09-14**.
> Single source of truth for this scope. **Do not re-scope from memory.**
> Companion to [MTGA-UX-OVERHAUL.md](MTGA-UX-OVERHAUL.md) (play surface),
> [SUGGEST-THEMES.md](SUGGEST-THEMES.md) (Lab → Suggest),
> [OFFLINE-AND-DISTRIBUTION.md](OFFLINE-AND-DISTRIBUTION.md) (delivery).

## 0. The requests, verbatim

> make it so you can prefer a favorite card variant art-wise for a given card - but add a further
> override layer that's just per-deck.

> the mobile version of jonny boi is awful for deck building because the decks are on the bottom...

> deckbuilding tab needs a massive overhaul - the UX for it is awful!

---

## 1. DB-1 — Preferred art, with a per-deck override

### 1.1 MEASURED: the per-deck layer already exists. The GLOBAL one does not.

`apps/web/src/lib/printings/entryPrinting.ts` is already exactly the inner layer Caleb describes —
its own header says *"Per-deck-entry alternate printings: **this slot in THIS deck uses that art**"*.
It stores a self-contained `EntryPrinting` (Scryfall id, front/back image URLs, set code) **on the
deck entry**, deliberately rather than as a bare id, so a chosen printing still renders after a
reload with no network. `DeckEntryPrinting.tsx` is its UI; `ProxyOverridesPanel` does the same trick
for proxies.

So the request is **one new layer plus a precedence rule**, not a feature from scratch:

```
  printing for a card  =  per-deck override   (EXISTS — entryPrinting.ts)
                       ?? global favourite    (MISSING — DB-1)
                       ?? the bundled index's single canonical printing
```

### 1.2 What to build

- A **global favourite** store: card id → chosen printing, in the same self-contained shape
  `EntryPrinting` already uses (id + image URLs + set), for the same offline reason. Reuse that type
  rather than inventing a parallel record (rule 3).
- **One resolver** that every card-rendering surface calls, implementing the three-step precedence
  above. This is the part that must not be duplicated: the play surface, the deck builder, the proxy
  sheet and the card browser all answer "which art for this card?" — and they must answer it in one
  place, or a favourite will apply in three surfaces out of four. That failure has already happened
  on this project seven times in a different guise (MTGA-UX-OVERHAUL §7.3).
- The guard is an **adoption test**, not a unit test of the resolver: a closed table of card-render
  sites, asserting each goes through the resolver. `card-hover-adoption.test.ts` and
  `CardFace.test.ts`'s `CARD_SURFACES` are the models already in the repo.

### 1.3 Note on scale

The bundled `card-index.json` carries **one** printing per card on purpose — mirroring every
printing of thousands of cards would balloon the build for a cosmetic choice. Alternate printings are
fetched on demand from Scryfall and TTL-cached in localStorage. A global favourites store must not
change that: it stores the *chosen* printings only. ⚠️ And it interacts with **DIST-1** (run fully
offline): a favourite whose art was never fetched has no image. It must degrade to the canonical
printing and **say so**, not render a blank card.

---

## 2. DB-2 — Mobile deck building

### 2.1 MEASURED, structurally: there is no mobile layout at all

`styles.css:833-839`:

```css
.deck-layout {
  display: grid;
  grid-template-columns: 1fr minmax(320px, 380px);
  gap: var(--space-5);
  align-items: start;
}
.deck-panel { position: sticky; top: calc(var(--header-height) + var(--space-4)); … }
```

**No `@media` rule in the entire stylesheet touches `.deck-layout`, `.deck-panel` or any
`deck-builder` class.** (Verified by sweeping every media block for those selectors — zero hits.)

So the deck builder is a fixed two-column desktop grid whose right column demands **at least 320px**,
with a sidebar that is `position: sticky` because it was designed as a desktop sidebar. On a 375px
phone the second column alone claims 85% of the viewport width. That is the whole explanation for
"awful on mobile", and it is not a tuning problem — the layout has no phone shape to fall back to.

Compare `board-fit.css`, which has a full `@media (max-width: 39.999rem)` block for the play surface:
the play view was made responsive and the builder never was.

### 2.2 ⚠️ "the decks are on the bottom" is NOT yet reproduced

The CSS above predicts a *crushed side-by-side* layout, not a stacked one. Caleb observes stacking,
so something else — a wrapper, a container query, or the browser collapsing the `1fr` track — is
also in play. **Do not design against the CSS reading.** Capture the builder at 375×812 in a real
browser first and work from the frame. This project's standing lesson (§7.3) is that structural
reasoning about layout is exactly what keeps being wrong here.

---

## 3. DB-3 — "the UX is awful", made actionable

A massive overhaul briefed from the word *awful* will produce a redesign nobody asked for. Caleb's
two concrete complaints (art variants, mobile) are in DB-1/DB-2; the rest of DB-3 must be
**evidence first**.

### 3.1 The method, which this machine already has

Run a real UX/UI review pass against the running deck builder — desktop **and** phone — and file
evidence-backed findings, each with a capture. The `testmebro` skill on this machine exists for
exactly this ("play one of this machine's games or apps like a real player and file evidence-backed
review findings another Claude can fix"), and its doctrine is already memorised as project canon.
Use it rather than inventing a review format.

### 3.2 What the review must cover, at minimum

The core loop of the tab: **find a card → judge it → add/remove copies → see what it did to the
deck.** Specifically —

- Search and filtering across a **6,000+ card** pool: how many actions to find one card?
- Adding/removing copies: how many taps for a 4-of? Is the current count legible without hunting?
- Feedback: does the curve / colour / legality readout update where the eye already is, or elsewhere?
- The two-panel relationship at every width, not just the one the author used.
- Whether the deck's *validity* (60-card minimum, copy limits) is stated continuously or only on a
  failed action.

### 3.3 The acceptance bar

Not "it looks better" — a **measured reduction in interactions** for the core loop, reported as a
before/after count on a named task ("add 4 copies of a card you have to search for, starting from an
empty deck"), plus every filed finding either fixed or explicitly deferred with a reason.
