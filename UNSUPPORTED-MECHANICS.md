# Unsupported mechanics — the engine work queue

This is where "the app couldn't play that card" turns into work someone can pick up.

## The contract

The Oracle-text compiler (`packages/cards/src/compile`) **never approximates**. A
card either compiles to a definition whose every printed ability is genuinely
implemented, or it is reported `incomplete` with the exact clause and the engine
system it would need. A half-modelled card would behave as a blank and silently
corrupt the A/B verdicts this whole project exists to produce, so a card we cannot
play is kept, shown, and *marked* — never quietly downgraded.

That honesty runs end to end:

- **Card level** — adding a card à la carte reports precisely which systems its
  text needs (`lib/cards/addSingleCard.ts`).
- **Deck level** — a deck containing any such card is badged "N cards not
  playable" and names them (`lib/decklist/deckHealth.ts`). One unplayable card
  makes the whole deck unplayable; there is no "mostly fine".
- **Simulation level** — an unplayable card never reaches `importedDefinitions()`,
  so it physically cannot enter a sim.

## Where the live list lives

The app accumulates every gap it meets, grouped by the missing **system** (the
unit of work — implement it once, unblock every card waiting on it), with the
cards blocked and a verbatim clause to implement against.

**To read it:** open the app → **Cards** → add any card that needs a missing
system, or check the registry directly. Export it as Markdown with
`formatUnsupportedReport()` from `apps/web/src/lib/cards/unsupportedRegistry.ts`
and paste the result below.

It is stored per-browser (localStorage), because it is driven by the cards *this
user* actually tried to add. That is the point: the queue reflects real demand
rather than a speculative wishlist.

## Outstanding — the measured backlog

**→ [UNSUPPORTED-BACKLOG.md](UNSUPPORTED-BACKLOG.md) is the ranked list. Work from the top.**

**→ [docs/plans/keyword-family-waves.md](docs/plans/keyword-family-waves.md) is the WORK QUEUE**
— the remaining keyword families with their measured sole-blocked counts, the engine shape each
needs, and the protocol a wave is run by. Pick keyword work from there, not from the ranked list
below: the list is ranked by refusal message, and its top row is a bucket of hundreds of unrelated
sentences rather than one work item (DESIGN §3.120).

**→ [docs/plans/mechanic-completion-plan.md](docs/plans/mechanic-completion-plan.md) is what
the backlog *means*:** the finish line with a number on it (2093/2100 = 99.7%, because the
genuinely-unrepresentable set turns out to be seven cards), the wave-by-wave path there, and
the reason the top of the raw backlog is **not** always the right next thing to build — a gap
that blocks 38 cards but is the sole blocker for none of them moves the playable count by
zero. Read it before picking work off the list below.

That file is *generated*, not written:

```bash
# The network run. Cache the corpus while you are here — the fetch is the only
# online step, and a cached corpus makes every later re-run offline and identical.
node packages/cards/scripts/coverage-audit.mjs --pages 12 --out UNSUPPORTED-BACKLOG.md \
  --json audit.json --save-corpus corpus.json

# Re-measure offline against the same corpus (what you do after landing a system):
node packages/cards/scripts/coverage-audit.mjs --input corpus.json --top 0 --json audit.json
```

It runs every card of the corpus it is given — since §3.118 the committed backlog is measured over the WHOLE printed corpus (32,277 paper non-joke cards, the same file every §3.10x family is measured against), not a most-played sample — 
through the real compiler, and ranks each missing engine system by **how many
cards it blocks**. So the top entry is, by construction, the highest-value engine
work available — not the one someone happened to hit.

`--json` is the one to reach for when planning: the Markdown is only the top 25, while
the JSON carries **every** gap with its full blocked-card list and a `kind` of `system`
(engine work) or `template` (a rule-table entry). Inverting it gap→card gives the number
that actually predicts progress — how many cards a gap is the *sole* blocker for.

This complements the in-app registry below rather than replacing it: the registry
reflects what *this user* tried to add, the audit reflects what the format plays.
When they disagree, the registry wins — it is real demand.

⚠️ **Re-run the audit after landing a system**, and put the before/after in your
commit. "Blocks 158 cards" is a claim that expires; the only honest way to say a
mechanic mattered is to show the playable count move.

_The in-app registry format, for pasting a triage below:_

```
## <missing engine system>

- **Blocks N card(s):** Card A, Card B
- **Occurrences:** N
- **Example clause:** `the exact printed text`
```

### Known gaps already visible in the curated pool

These are documented in the compiler's own tests
(`packages/cards/src/compile/compile.test.ts`, `HUMAN_APPROXIMATIONS`) — the
compiler refuses to reproduce them rather than fake them:

| System | Example card | Note |
|---|---|---|
| dynamic power/toughness (`*/*`) | Tarmogoyf | Characteristic-defining ability |
| transform / double-faced cards | Delver of Secrets | Needs a second face + transform |
| planeswalker loyalty abilities | Liliana of the Veil | Loyalty costs, one activation per turn |

## Picking one up

1. Choose the system blocking the most cards.
2. Implement the engine system in `packages/core` (a primitive, a rules hook, or
   a new action) with tests — see [TESTING.md](TESTING.md) for where it belongs.
3. Add the compiler rule in `packages/cards/src/compile/rules.ts` so real Oracle
   text now matches.
4. Add the blocked example card to the compiler test as ground truth, and drop it
   from any approximation exemption list.
5. Re-add the card in the app; it should now report as fully playable.
