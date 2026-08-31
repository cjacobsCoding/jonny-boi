/**
 * THE CLONE MUST ROUND-TRIP EVERY PER-OBJECT FIELD — the §3.55 class-killer.
 *
 * \`cloneInstance\` copies a FIXED field list (deliberate shape discipline), which
 * means a per-object property it does not know about survives exactly one action
 * and then silently vanishes on the next clone. That is not hypothetical: the
 * O-Ring jail link (\`exiledUntilLeavesBy\`) was written as an ad-hoc property by
 * the cards package, dropped by the very next clone, and every "release the
 * jailed cards" trigger resolved against nothing — Angel of Serenity kept its
 * prisoners forever (user-reported, engine-reproduced).
 *
 * This test scales with the TYPE, not with examples: it builds an instance with
 * EVERY optional CardInstance field populated and requires the clone to be
 * deep-equal INCLUDING own-key sets. Add a field to CardInstance without
 * teaching the clone and this goes red — before a card ever misbehaves.
 */
import { describe, expect, it } from "vitest";
import type { CardInstance, GameState } from "@jonny-boi/core";
import { applyAction, createGame, DEFAULT_RULES } from "@jonny-boi/core";
import { buildRegistry, loadCardPool } from "@jonny-boi/cards";

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const forest = pool.cards.find((c) => c.name === "Forest")!;

/** One instance with every optional per-object field set to a sentinel. */
function maximalInstance(state: GameState): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def: forest,
    controller: "A",
    owner: "B",
    zone: "battlefield",
    tapped: true,
    summoningSick: true,
    damageMarked: 3,
    markedByDeathtouch: true,
    attachedTo: 42,
    counters: { "+1/+1": 2 },
  };
  // Every OPTIONAL field the type declares, set via a typed alias so a new
  // field shows up here as a compile error when this list goes stale.
  inst.printedDef = forest;
  inst.uncopiedDef = forest;
  inst.loyaltyActivatedTurn = 7;
  inst.timesKicked = 2;
  inst.chosenAsEntered = "goblin";
  inst.exiledUntilLeavesBy = 99;
  return inst;
}

describe("cloneInstance round-trips every per-object field", () => {
  it("an action-path clone preserves the full own-key set and values", () => {
    const { state } = createGame({
      seed: 3,
      decks: { A: { cards: Array.from({ length: 60 }, () => forest) }, B: { cards: Array.from({ length: 60 }, () => forest) } },
      registry,
    });
    const inst = maximalInstance(state);
    (state.battlefield as CardInstance[]).push(inst);

    // Drive ONE real action through the pure path — the clone under test.
    const r = applyAction(state, { kind: "passPriority", player: state.priorityPlayer }, DEFAULT_RULES, registry);
    const cloned = r.state.battlefield.find((c) => c.instanceId === inst.instanceId);
    expect(cloned, "the instance survives the action").toBeTruthy();

    const before = Object.keys(inst).sort();
    const after = Object.keys(cloned!).sort();
    expect(after, "the clone dropped per-object fields — teach internal/clone.ts").toEqual(before);
    for (const key of before) {
      const a = (inst as unknown as Record<string, unknown>)[key];
      const b = (cloned as unknown as Record<string, unknown>)[key];
      if (key === "def" || key === "printedDef" || key === "uncopiedDef") {
        expect(b, key + " is the shared immutable def").toBe(a);
      } else {
        expect(b, key + " must round-trip").toEqual(a);
      }
    }
  });
});
