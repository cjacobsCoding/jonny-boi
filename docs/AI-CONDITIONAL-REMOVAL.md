# The pilot aims removal it cannot cast to kill (§AI-1)

> **Status: durable reference. NOT STARTED.** Raised by Caleb on **2026-09-14** from real play.
> Single source of truth for this scope. **Do not re-scope from memory.**

## 0. The report, verbatim

> the AI doesnt seem to understand how to use the spell 'Fatal Push' - it tried to use it on my
> Thragtusk and Restoration Angel, and neither attempt did anything

## 1. The rules are CORRECT. This is an AI defect.

Checked before blaming anything:

- **Fatal Push is implemented faithfully** (`packages/cards/data/pool.ts:150-166`):
  `destroyTarget` with `params: { targets: 'creature', maxManaValue: { base: 2, revolt: 4 } }`.
  The compiler rule `destroy-creature-mana-value-revolt` deliberately joins both printed lines onto
  ONE `destroyTarget` ref, because *"that creature"* in the revolt rider has no referent alone and
  compiling the halves separately would destroy twice. The bound is read at **resolution** against
  core's turn-scoped fact memory, so a permanent leaving in response turns revolt on before the
  spell resolves — exactly as the printed card behaves.
- **Thragtusk is mana value 5** — Fatal Push can never destroy it, revolt or not.
- **Restoration Angel is mana value 4** — destroyable only with revolt active.

So both spells resolved and correctly did nothing. The engine is right; the pilot aimed a spell
where it could not work, twice.

## 2. The CLASS: conditions checked at RESOLUTION are invisible to a legality-driven pilot

This is the shape, and it is worth stating precisely because it explains why a good pilot gets it
wrong:

- The pilot chooses from **legal actions**. Target legality is enforced by the engine.
- *"Destroy target creature **if** it has mana value 2 or less"* makes **every creature a legal
  target**. The mana-value bound is not a targeting restriction at all — it is a condition on the
  EFFECT, tested when the spell resolves.
- So to a chooser reading legality, a lethal target and a useless one are **indistinguishable**.

Measured: `grep -n "maxManaValue\|notColor"` over `packages/ai/src` returns **nothing**. The pilot
never reads the parameters that decide whether a removal spell actually kills. Every `destroyTarget`
is scored as though it always destroys (`heuristic.ts:162-165`).

### 2.1 Do not fix Fatal Push. Fix the shape.

Rule 1. The sibling to check FIRST, because it is the same primitive with a different gate:

- **Doom Blade** (`pool.ts:147`) — `destroyTarget` with `notColor: 'B'`.

⚠️ **But verify the distinction before treating them the same**, because it changes the fix:
`notColor` looks like a **targeting restriction** ("target nonblack creature"), which the engine
should refuse at cast time — in which case the pilot cannot make that mistake and Doom Blade is
fine. `maxManaValue` is a **resolution condition**, which the engine must allow. Establish which of
the two each gating param is; the pilot only needs teaching about the second kind. Sweep the pool
for every param that gates an effect rather than a target, and report the count — that number is the
real size of this work.

## 3. What to build

- The pilot's removal scoring must ask *"would this actually destroy it?"*, not *"is it a creature?"*.
  That predicate belongs beside the effect's own data, **not** as a second table in the AI: a
  parallel list of "which removal kills what" would drift from the pool the moment a card is added
  (rule 3). Prefer deriving it from the same `params` the engine reads at resolution.
- **Revolt is state-dependent, which is the interesting part.** Fatal Push's bound is 4 *when a
  permanent left your battlefield this turn*. A pilot that models this can deliberately sequence a
  sacrifice or a blink FIRST and then kill a 4-drop — that is real play skill, and the same fact
  memory the engine reads is available to the pilot. Bare minimum: do not aim it at what it cannot
  kill. Better: know when it can.

## 4. Guards

- A behavioural test: with no revolt, the pilot offered Fatal Push and a mana-value-5 creature does
  **not** cast it at that creature. With revolt on and a mana-value-4 creature, it **does**.
  Both directions — a rule that only ever refuses is as wrong as one that only ever fires.
- A **class guard**: sweep the compiled pool for effects carrying a resolution-gating param and
  assert the pilot's scorer consults each one. A new gating param added to the pool without teaching
  the pilot must fail the suite — otherwise this recurs with the next conditional removal spell.
- ⚠️ **Perf**: the pilot's scorer is the hot path (`packages/ai` runs inside thousands of sim games,
  measured at ~177k decisions/sec). Measure before and after with the committed pilot bench and
  report both numbers. A per-candidate pool lookup in that loop is exactly the kind of change that
  costs 20% and is noticed a week later.
- ⚠️ **Behaviour lock**: `selfplay-lock.test.ts` pins seeded outcomes. Teaching the pilot WILL move
  some of them — that is the point — but the diff must be inspected and the new results accepted
  deliberately, not rubber-stamped.
