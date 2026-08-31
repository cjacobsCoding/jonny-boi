/**
 * SOLO PROMPT PLUMBING — the web session must SURFACE the questions the engine
 * parks, and auto-advance must STOP for them (user report: "played Gatecreeper
 * Vine and DID NOT get to search").
 *
 * Engine-level tests already prove the question is asked; what the user hit can
 * only live in this layer — the session the PlayView renders from. So this
 * drives the REAL GameSession exactly as PlayView does: cast, auto-advance,
 * and assert the may-search confirm parks, is meaningful, and answering YES
 * parks the card-picker next.
 */
import { describe, expect, it } from "vitest";
import { createGame, defaultAnswerFor, type GameState } from "@jonny-boi/core";
import { buildRegistry, loadCardPool } from "@jonny-boi/cards";
import { GameSession } from "./session.js";

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const byName = (n: string) => pool.cards.find((c) => c.name === n)!;

function soloSession(): GameSession {
  const forest = byName("Forest");
  const created = createGame({
    seed: 5,
    decks: { A: { cards: Array.from({ length: 60 }, () => forest) }, B: { cards: Array.from({ length: 60 }, () => forest) } },
    registry,
  });
  return GameSession.fromCreated(created, registry, { A: "Player 1", B: "Computer" });
}

/** Walk to A'"'"'s precombat main with an empty stack, answering nothing en route. */
function toMain(session: GameSession): GameSession {
  let s = session, guard = 0;
  while (guard++ < 400) {
    const st = s.state as GameState;
    if (st.step === "precombatMain" && st.priorityPlayer === "A" && st.stack.length === 0 && !s.pendingChoice) break;
    if (s.pendingChoice) s = s.answerChoice(defaultAnswerFor(s.pendingChoice)).session;
    else s = s.passPriority().session;
  }
  return s;
}

describe("Gatecreeper Vine through the web session", () => {
  it("parks the may-search question, auto-advance stops, YES parks the picker", () => {
    let s = toMain(soloSession());
    const st = s.state as GameState;
    const vine = { instanceId: st.nextInstanceId++, def: byName("Gatecreeper Vine"), controller: "A" as const, owner: "A" as const, zone: "hand" as const, tapped: false, summoningSick: false, damageMarked: 0, markedByDeathtouch: false, attachedTo: null, counters: {} };
    (st.players.A.hand as unknown[]).push(vine);
    st.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 4, C: 4 } as never;

    let r = s.submit({ kind: "castSpell", player: "A", instanceId: vine.instanceId, targets: [] });
    expect(r.rejected, "cast accepted").toBeNull();
    s = r.session;

    // Resolve the spell + its ETB trigger by passing — exactly what the solo
    // loop does when neither seat holds anything meaningful.
    let guard = 0;
    while (!s.pendingChoice && guard++ < 20) {
      s = s.autoAdvancePriority();
      if (s.pendingChoice) break;
      s = s.passPriority().session;
    }
    expect(s.pendingChoice, "the may-search question must surface").toBeTruthy();
    expect(s.hasMeaningfulChoice(), "auto-advance must treat it as a stop").toBe(true);
    const q1 = s.pendingChoice!;
    expect(q1.prompt.toLowerCase()).toContain("search");

    // YES -> the engine must now park the actual card selection.
    r = s.answerChoice({ kind: "confirm", yes: true } as never);
    expect(r.rejected).toBeNull();
    s = r.session;
    let guard2 = 0;
    while (!s.pendingChoice && guard2++ < 10) s = s.passPriority().session;
    expect(s.pendingChoice, "the search picker must follow a yes").toBeTruthy();
    expect(s.pendingChoice!.kind).toBe("selectCards");
  });
});
