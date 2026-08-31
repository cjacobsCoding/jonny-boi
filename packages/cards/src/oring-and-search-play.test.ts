/**
 * O-RING AND MAY-SEARCH, END TO END — cast → trigger → question → effect,
 * through the REAL action loop (§3.55, both user-reported in a Solo game).
 *
 * Two regressions pinned here found the gap between "the primitive works when
 * driven directly" and "the card works when played":
 *  - Banisher Priest with no legal target: the trigger leaves the stack by
 *    rule (CR 603.3d); the fix was a LOG line, and this file pins the happy
 *    path so the exile itself can never silently regress.
 *  - Gatecreeper Vine: the printed "basic land card OR a Gate card" was
 *    encoded as an INTERSECTION (subtype filter ∩ basic-name list) = the empty
 *    set, so the picker auto-answered an empty selection — the user consented
 *    to search and nothing happened. Now a CardFilter.anyOf disjunction.
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

function makeGame() {
  const forest = byName("Forest");
  const { state } = createGame({
    seed: 7,
    decks: { A: { cards: Array.from({ length: 60 }, () => forest) }, B: { cards: Array.from({ length: 60 }, () => forest) } },
    registry,
  });
  return state;
}

function toMain(state: GameState): GameState {
  let s = state, guard = 0;
  while ((s.step !== "precombatMain" || s.priorityPlayer !== "A" || s.stack.length > 0 || s.pendingChoice) && guard++ < 600) {
    if (s.pendingChoice) {
      const q = s.pendingChoice;
      s = act(s, { kind: "answerChoice", player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) }).state;
    } else {
      s = act(s, { kind: "passPriority", player: s.priorityPlayer }).state;
    }
  }
  return s;
}

function put(state: GameState, name: string, controller: "A" | "B", opts: { hand?: boolean } = {}) {
  const def = byName(name);
  const id = state.nextInstanceId++;
  const inst = {
    instanceId: id, def, controller, owner: controller,
    zone: opts.hand ? "hand" : "battlefield",
    tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false,
    attachedTo: null, counters: {},
  } as never;
  if (opts.hand) (state.players[controller].hand as unknown[]).push(inst);
  else (state.battlefield as unknown[]).push(inst);
  return id;
}

describe("Banisher Priest end to end", () => {
  it("exiles the chosen creature via cast -> trigger -> answer", () => {
    let s = toMain(makeGame());
    const bear = put(s, "Grizzly Bears", "B");
    const priest = put(s, "Banisher Priest", "A", { hand: true });
    s.players.A.manaPool = { W: 5, U: 0, B: 0, R: 0, G: 0, C: 5 } as never;

    const trail: string[] = [];
    let r = act(s, { kind: "castSpell", player: "A", instanceId: priest, targets: [] });
    expect(r.rejected).toBeNull();
    for (const e of r.events) trail.push(e.type + (("reason" in e) ? " [" + (e as {reason:string}).reason + "]" : ""));
    s = r.state;
    // resolve the spell (both pass)
    let guard = 0;
    while (s.stack.length > 0 && guard++ < 50 && !s.pendingChoice) {
      r = act(s, { kind: "passPriority", player: s.priorityPlayer });
      expect(r.rejected).toBeNull();
      for (const e of r.events) trail.push(e.type + (("reason" in e) ? " [" + (e as {reason:string}).reason + "]" : ""));
      s = r.state;
    }
    console.log("EVENT TRAIL:\n  " + trail.join("\n  "));
    console.log("after cast+resolve: stack=", s.stack.map((o) => (o as {kind:string}).kind), "pending=", s.pendingChoice?.prompt, "choices offered=", s.pendingChoice?.kind);
    // One candidate auto-answers (CR-correct); a manual answer only exists when 2+.
    if (s.pendingChoice) {
      const q = s.pendingChoice;
      r = act(s, { kind: "answerChoice", player: q.chooser, choiceId: q.id, answer: { kind: "selectTargets", targets: [bear] } });
      expect(r.rejected).toBeNull();
      s = r.state;
    }
    guard = 0;
    while ((s.stack.length > 0 || s.pendingChoice) && guard++ < 50) {
      if (s.pendingChoice) { const q2 = s.pendingChoice; s = act(s, { kind: "answerChoice", player: q2.chooser, choiceId: q2.id, answer: defaultAnswerFor(q2) }).state; }
      else s = act(s, { kind: "passPriority", player: s.priorityPlayer }).state;
    }
    const bearOnField = s.battlefield.some((c) => c.instanceId === bear);
    const bearInExile = s.players.B.exile.some((c) => c.instanceId === bear);
    console.log("bear on field:", bearOnField, "in exile:", bearInExile);
    expect(bearInExile, "the chosen creature must be exiled").toBe(true);
  });
});

describe("Gatecreeper Vine end to end", () => {
  it("asks the search question after it enters", () => {
    let s = toMain(makeGame());
    const vine = put(s, "Gatecreeper Vine", "A", { hand: true });
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 5, C: 5 } as never;
    let r = act(s, { kind: "castSpell", player: "A", instanceId: vine, targets: [] });
    expect(r.rejected).toBeNull();
    s = r.state;
    let guard = 0; const prompts: string[] = [];
    while ((s.stack.length > 0 || s.pendingChoice) && guard++ < 60) {
      if (s.pendingChoice) {
        prompts.push(s.pendingChoice.kind + " :: " + s.pendingChoice.prompt);
        break;
      }
      s = act(s, { kind: "passPriority", player: s.priorityPlayer }).state;
    }
    console.log("prompts seen:", prompts);
    expect(prompts.length, "the may-search question must be asked").toBeGreaterThan(0);

    // Say YES — the actual card picker must follow (user: "DID NOT get to search").
    const q = s.pendingChoice!;
    r = act(s, { kind: "answerChoice", player: q.chooser, choiceId: q.id, answer: { kind: "confirm", yes: true } });
    expect(r.rejected).toBeNull();
    for (const e of r.events) if (/choice|search|Removed/i.test(e.type)) console.log("  after-yes:", JSON.stringify(e).slice(0, 240));
    s = r.state;
    let g2 = 0;
    while (!s.pendingChoice && s.stack.length > 0 && g2++ < 20) s = act(s, { kind: "passPriority", player: s.priorityPlayer }).state;
    console.log("after yes: pending=", s.pendingChoice?.kind, s.pendingChoice?.prompt?.slice(0,60));
    expect(s.pendingChoice?.kind, "the search picker must follow a yes").toBe("selectCards");
  });
});
