/**
 * THE JAIL LINK MUST SURVIVE THE CLONE (§3.56, user-reported).
 *
 * Angel of Serenity jailed two creatures; a Closet-style blink removed and
 * returned the Angel; the release trigger fired — and freed nothing, because
 * the exiledUntilLeavesBy link was an ad-hoc property that core's per-action
 * clone silently dropped. The link is a real CardInstance field now, and
 * clone-completeness.test.ts guards the whole class; this pins the play.
 */
import { describe, expect, it } from "vitest";
import {
  applyAction, createGame, DEFAULT_RULES, defaultAnswerFor,
  type GameAction, type GameState,
} from "@jonny-boi/core";
import { buildRegistry, loadCardPool } from "@jonny-boi/cards";

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const byName = (n: string) => { const c = pool.cards.find((x) => x.name === n); if (!c) throw new Error("missing " + n); return c; };

function act(state: GameState, action: GameAction) {
  const r = applyAction(state, action, DEFAULT_RULES, registry);
  const rej = r.events.find((e) => e.type === "actionRejected") as { reason?: string } | undefined;
  return { state: r.state, rejected: rej?.reason ?? null, events: r.events };
}
function drain(state: GameState, pick?: (q: NonNullable<GameState["pendingChoice"]>) => unknown) {
  let s = state, guard = 0;
  const trail: string[] = [];
  while ((s.stack.length > 0 || s.pendingChoice) && guard++ < 80) {
    if (s.pendingChoice) {
      const q = s.pendingChoice;
      const answer = (pick ? pick(q) : null) ?? defaultAnswerFor(q);
      const r = act(s, { kind: "answerChoice", player: q.chooser, choiceId: q.id, answer: answer as never });
      for (const e of r.events) trail.push(e.type + ((e as {reason?:string}).reason ? " ["+(e as {reason:string}).reason+"]" : ""));
      s = r.state;
    } else {
      const r = act(s, { kind: "passPriority", player: s.priorityPlayer });
      for (const e of r.events) trail.push(e.type + ((e as {reason?:string}).reason ? " ["+(e as {reason:string}).reason+"]" : ""));
      s = r.state;
    }
  }
  return { s, trail };
}
function toMain(state: GameState): GameState {
  let s = state, guard = 0;
  while ((s.step !== "precombatMain" || s.priorityPlayer !== "A" || s.stack.length > 0 || s.pendingChoice) && guard++ < 600) {
    if (s.pendingChoice) { const q = s.pendingChoice; s = act(s, { kind: "answerChoice", player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }).state; }
    else s = act(s, { kind: "passPriority", player: s.priorityPlayer }).state;
  }
  return s;
}
function put(state: GameState, name: string, controller: "A" | "B", zone: "battlefield" | "hand" = "battlefield") {
  const def = byName(name);
  const id = state.nextInstanceId++;
  const inst = { instanceId: id, def, controller, owner: controller, zone,
    tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, attachedTo: null, counters: {} } as never;
  if (zone === "hand") (state.players[controller].hand as unknown[]).push(inst);
  else (state.battlefield as unknown[]).push(inst);
  return id;
}

describe("Angel of Serenity x a Closet-style blink", () => {
  it("returns the jailed cards to their owners hands when the Angel is blinked", () => {
    const forest = byName("Forest");
    const { state } = createGame({ seed: 11, decks: { A: { cards: Array.from({length:60},()=>forest) }, B: { cards: Array.from({length:60},()=>forest) } }, registry });
    let s = toMain(state);
    const bear = put(s, "Grizzly Bears", "B");
    const wolf = put(s, "Runeclaw Bear", "B");
    const angelHand = put(s, "Angel of Serenity", "A", "hand");
    const shift = put(s, "Cloudshift", "A", "hand");
    s.players.A.manaPool = { W: 9, U: 0, B: 0, R: 0, G: 0, C: 9 } as never;

    // Cast the Angel; on the ETB question, jail BOTH of B'"'"'s creatures.
    let r = act(s, { kind: "castSpell", player: "A", instanceId: angelHand, targets: [] });
    expect(r.rejected).toBeNull();
    let d = drain(r.state, (q) => q.kind === "selectTargets" ? { kind: "selectTargets", targets: [bear, wolf] } : null);
    s = d.s;
    expect(s.players.B.exile.map((c)=>c.instanceId).sort()).toEqual([bear, wolf].sort());
    const angelOnField = s.battlefield.find((c) => c.def.name === "Angel of Serenity");
    expect(angelOnField, "angel resolved to the battlefield").toBeTruthy();

    // Blink the Angel exactly as Conjurer'"'"'s Closet / Cloudshift do.
    r = act(s, { kind: "castSpell", player: "A", instanceId: shift, targets: [angelOnField!.instanceId] });
    expect(r.rejected).toBeNull();
    // On the re-entry ETB question, decline to jail anything (choose none).
    d = drain(r.state, (q) => q.kind === "selectTargets" ? { kind: "selectTargets", targets: [] } : null);
    s = d.s;
    console.log("TRAIL:\n  " + d.trail.filter((t)=>/trigger|zone|choice|exile|Removed/i.test(t)).join("\n  "));
    console.log("B exile:", s.players.B.exile.map((c)=>c.def.name), "B hand size:", s.players.B.hand.length);
    expect(s.players.B.exile.length, "nothing may stay jailed after the jailer left").toBe(0);
    const hand = s.players.B.hand.map((c) => c.instanceId);
    expect(hand).toEqual(expect.arrayContaining([bear, wolf]));
  });
});
