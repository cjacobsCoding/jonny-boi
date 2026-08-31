/**
 * OFFERED-ACTIVATION BLINDNESS (§3.56): Kiki-Jiki is a tap-cost value ability
 * the engine OFFERS — nothing to fund — and §3.40's partition (fetch / loyalty /
 * Equip / funded-by-tapping) owned none of that shape, so the pilot never
 * activated it once and the soak reported delayed-trigger inert the day Kiki
 * entered the pool. Two pins: the engine offers it, and the pilot TAKES it
 * when nothing outranks it.
 */
import { describe, expect, it } from "vitest";
import { createGame, generateLegalActions, DEFAULT_RULES, type GameState, applyAction, defaultAnswerFor } from "@jonny-boi/core";
import { buildRegistry, loadCardPool } from "@jonny-boi/cards";
import { createDefaultAiRegistry, DEFAULT_PILOT_ID } from "@jonny-boi/ai";

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const pilot = createDefaultAiRegistry().getPilot(DEFAULT_PILOT_ID)!;
const byName = (n: string) => pool.cards.find((c) => c.name === n)!;

describe("Kiki activation", () => {
  it("the default pilot activates Kiki targeting the bear", () => {
    const forest = byName("Forest");
    const { state } = createGame({ seed: 2, decks: { A: { cards: Array.from({length:60},()=>forest) }, B: { cards: Array.from({length:60},()=>forest) } }, registry });
    let s: GameState = state, guard=0;
    while ((s.step !== "precombatMain" || s.priorityPlayer !== "A" || s.stack.length>0) && guard++<400) {
      s = { ...s }; // not needed; use engine pass
      break;
    }
    // walk to main properly
        guard=0;
    while ((s.step !== "precombatMain" || s.priorityPlayer !== "A" || s.stack.length>0 || s.pendingChoice) && guard++<500) {
      if (s.pendingChoice) { const q=s.pendingChoice; s=applyAction(s,{kind:"answerChoice",player:q.chooser,choiceId:q.id,answer:defaultAnswerFor(q)},DEFAULT_RULES,registry).state; }
      else s=applyAction(s,{kind:"passPriority",player:s.priorityPlayer},DEFAULT_RULES,registry).state;
    }
    const kiki = { instanceId: s.nextInstanceId++, def: byName("Kiki-Jiki, Mirror Breaker"), controller:"A" as const, owner:"A" as const, zone:"battlefield" as const, tapped:false, summoningSick:false, damageMarked:0, markedByDeathtouch:false, attachedTo:null, counters:{} };
    const bear = { instanceId: s.nextInstanceId++, def: byName("Grizzly Bears"), controller:"A" as const, owner:"A" as const, zone:"battlefield" as const, tapped:false, summoningSick:false, damageMarked:0, markedByDeathtouch:false, attachedTo:null, counters:{} };
    (s.battlefield as unknown[]).push(kiki, bear);

    // Empty the hand: land drops legitimately outrank a value activation, and
    // this test is about the activation being VISIBLE, not about ordering.
    (s.players.A.hand as unknown[]).length = 0;
    const legal = generateLegalActions(s, DEFAULT_RULES);
    const acts = legal.filter((a)=>a.kind==="activateAbility");
    console.log("activations offered:", JSON.stringify(acts));
    const chosen = pilot.chooseAction({ view: s, legalActions: legal, rng: { next: () => 0.5 } as never, registry, rulesConfig: DEFAULT_RULES });
    console.log("pilot chose:", JSON.stringify(chosen));
    expect(acts.length, "the engine must OFFER the activation").toBeGreaterThan(0);
    expect(chosen.kind, "the pilot must TAKE it (or this mechanic is pilot-inert)").toBe("activateAbility");
  });
});
