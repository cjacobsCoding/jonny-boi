# The AI cannot see a combo — and the reason is wider than combos

Caleb, 2026-09-21, about two specific interactions in his own decks:

> -Does the AI correctly detect the infinite loop between Angel of Thune and Spikefeeder in the Thune's life deck, when it's playing, and handle that correctly? Because that seems like it should give the deck a massive advantage when that combo surfaces - I want to make sure its detecting that properly.
> -does the AI properly detect the combo and value in playing Curse of Exhaustion on an enemy and then Possibility Storm, and recognize that means the enemy can no longer play any spells while those are active? If not, make the AI so it can detect such things and value them properly.

Measured before anything was designed. The measurement is committed as
`packages/ai/scripts/combo-awareness.mjs` so the next decision is made from data too
(CLAUDE.md rule 11).

---

## Question 1 — Archangel of Thune + Spike Feeder: **NO, and it is worse than "undervalued"**

Both cards compile and the loop is fully supported by the engine. On a rigged board with both
pieces out and mana untapped:

```
Spike Feeder counters on entry: {"+1/+1":2}
legal actions on the Feeder: activateAbility #82 ability1
```

So the engine OFFERS the loop. Over twelve consecutive decisions the heuristic pilot chose:

| times | action |
|---|---|
| 10 | `passPriority` |
| 1 | `playLand` |
| 1 | `declareAttackers` |

**Zero activations.** Life went 20 → 23, and those 3 came from combat, not the combo.

### ⚠️ The root cause is not combo blindness. It is that the pilot only activates abilities it has a NAMED RECOGNISER FOR.

Every activation path in `heuristic.ts` is a special case that bails on anything it does not
recognise — `bestAbility` (line ~1194) and the option builder (line ~5092) both read:

```ts
if (action.kind !== 'activateAbility') continue;
const ability = source?.def.activated?.[action.abilityIndex];
if (!ability || !fetchesALand(ability)) continue;
```

There is **no general path that prices an arbitrary activated ability by its effect and uses it when
the value is positive.** So a FREE "gain 2 life" is never scored at all — it is not judged
low-value, it is never considered. That means **every activated ability outside the recognised
families is invisible to the AI**, which is a far larger hole than these two cards, and is the
class to fix (CLAUDE.md rule 10).

`effect-value.ts` already prices the effects — `gainLife` is priced at line 693. The pricing exists;
nothing routes an activation through it.

### ⚠️ And the obvious fix, alone, is a bug

A greedy pilot that DOES value "+2 life for free" activates, the Angel returns the counter, and it
activates again — forever, until the engine's 104.4b loop machinery calls a draw. **Turning the deck's
best line into a draw is worse than ignoring it.** So valuing the ability and recognising the LOOP
have to land together. `packages/core/src/combo.ts` (§3.178) already detects exactly this shape; it
is switched off for pilots because `DEFAULT_RULES.comboDetectionSeats` is empty, which is what keeps
every simulation byte-identical today.

---

## Question 2 — Curse of Exhaustion + Possibility Storm: **NOT MEASURABLE**

```
NOT MEASURABLE — the pool does not carry: Possibility Storm, Curse of Exhaustion.
```

Neither card compiles, so no question about valuing them can be asked yet. **This is deliberately
not reported as "the AI ignores the lock":** that and "the cards do not exist" look identical from
outside and want completely different fixes.

His reading of the interaction is correct and is worth writing down for whoever implements it. The
Curse caps the enchanted player at one spell per turn. Possibility Storm exiles the spell they cast
and offers a replacement cast — which would be their SECOND spell that turn, and is therefore
prohibited. So every spell they cast is exiled and replaced by nothing: they cannot resolve a spell
from hand at all while both are out.

**Related and larger:** only **6 of the 14 names** in the deck those cards come from are playable —
Sphere of Safety, Assemble the Legion, Possibility Storm, Curse of Exhaustion, Pacifism, Burden of
Guilt, Terminus and Tibalt, the Fiend-Blooded are all absent. That is a card-campaign question, not
an AI one, and it blocks this half of the request outright.

---

## The shape of the work, in three stages that each stand alone

**Stage A — a general activation option, priced by effect.** One path that takes any
`activateAbility` the engine offers, prices its effect through `effect-value.ts`, subtracts the cost,
and emits a scored option. The named recognisers stay as overrides where they encode something the
generic price cannot see; each one that survives says why in a comment, and each one that does not is
deleted. **Acceptance: the pilot activates a free "gain 2 life" at least once.** That is the check to
make red first — it fails today.

**Stage B — a repetition cap, so Stage A cannot loop.** An ability whose activation returns the
state to an equivalent one is a LOOP, and `combo.ts` already decides that question. Rather than
build a second answer (rule 12), give the pilot the same signature check and let it take the loop a
BOUNDED number of times with a stated reason. **Acceptance: the Thune + Feeder board ends with the
pilot's life raised by a large, bounded amount and the game NOT a draw** — and a test that fails if
the game ends in a 104.4b draw, because that is the failure mode this stage exists to prevent.

**Stage C — valuing a lock.** Two permanents that together prohibit an opponent's whole class of
action are not visible to any per-card evaluation, because neither card alone does anything like it.
This wants a small, CLOSED table of recognised lock PATTERNS rather than open-ended reasoning —
"these two effects together mean the opponent cannot resolve spells from hand" is a row. Adding the
next lock is a row, not a code change (rule 2). **Blocked on the two cards compiling at all.**

## What must NOT happen

- No per-card special cases. "Spike Feeder is good with Archangel of Thune" as a hard-coded pair is
  exactly the shape rule 2 forbids, and it would not have found Heliod, Sun-Crowned — **also in that
  deck, and also an infinite with the Feeder.**
- No change to `DEFAULT_RULES.comboDetectionSeats` without re-running the determinism suite. Turning
  detection on for pilots changes what every simulation records, and the whole reason it is off is
  that sims stay byte-identical.
- No claim that the AI "understands combos" on the strength of one board. The acceptance runs on the
  real decks through the real gauntlet, and the honest number is a win-rate delta with a verdict, not
  a screenshot of one good turn.
