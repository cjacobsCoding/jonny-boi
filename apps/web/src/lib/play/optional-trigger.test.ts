/**
 * Bug report 20260901_205339 — Conjurer's Closet asked for a target and THEN
 * whether to use it. The engine order is correct (CR 603.3d targets on the way
 * to the stack, the "may" at resolution), so the fold is presentational: the
 * target prompt carries a decline, and taking it answers both.
 *
 * The whole point of these tests is that the signal is DATA: the first one
 * reads the REAL Conjurer's Closet out of the pool and asserts the primitive
 * this rule keys on is the one the compiler actually emits (TESTING.md rule 1 —
 * a test that invents an id proves nothing).
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  createGame,
  defaultAnswerFor,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type PendingChoice,
  type PlayerId,
} from '@jonny-boi/core';
import { GameSession } from './session.js';
import {
  hasOptionalTrigger,
  isDeclinedMayQuestion,
  MAY_PRIMITIVE,
  optionalTargetDecline,
} from './optional-trigger.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

const CLOSET = card("Conjurer's Closet");

function targetChoice(over: Partial<PendingChoice> = {}): PendingChoice {
  return {
    kind: 'selectTargets',
    id: 1,
    chooser: 'A',
    prompt: 'Choose a creature you control for your end step: you may exile target creature you control',
    valence: 'gain',
    sourceInstanceId: 30,
    sourceName: "Conjurer's Closet",
    min: 1,
    max: 1,
    candidates: [{ ref: 12, name: 'Elvish Visionary', controller: 'A' }],
    restriction: 'creatureYouControl',
    ...over,
  } as PendingChoice;
}

describe("the pool's own Conjurer's Closet is the shape this rule keys on", () => {
  it('prints a trigger whose effects are gated by the "you may" primitive', () => {
    expect(hasOptionalTrigger(CLOSET)).toBe(true);
    const primitives = (CLOSET.triggers ?? []).flatMap((t) => (t.effects ?? []).map((e) => e.primitive));
    expect(primitives).toContain(MAY_PRIMITIVE);
  });

  it('a trigger with no "may" does not qualify — Thragtusk just gains the life', () => {
    expect(hasOptionalTrigger(card('Thragtusk'))).toBe(false);
    expect(hasOptionalTrigger(undefined)).toBe(false);
  });
});

describe('optionalTargetDecline', () => {
  it('offers a decline on the reported prompt, naming the source', () => {
    expect(optionalTargetDecline(targetChoice(), CLOSET)).toBe(`Don’t use ${CLOSET.name}`);
  });

  it('offers nothing when the asking permanent has no optional trigger', () => {
    expect(optionalTargetDecline(targetChoice(), card('Thragtusk'))).toBeNull();
  });

  it('offers nothing on an "up to" choice, which already has its own decline', () => {
    // Angel of Serenity: min 0, and `ChoicePrompt` already renders "Choose none".
    expect(optionalTargetDecline(targetChoice({ min: 0 }), CLOSET)).toBeNull();
  });

  it('offers nothing on a question that is not about targets', () => {
    const confirm = { ...targetChoice(), kind: 'confirm' } as PendingChoice;
    expect(optionalTargetDecline(confirm, CLOSET)).toBeNull();
  });
});

describe('isDeclinedMayQuestion', () => {
  it('matches the follow-up confirm from the SAME permanent', () => {
    const confirm = { ...targetChoice(), kind: 'confirm', id: 2 } as PendingChoice;
    expect(isDeclinedMayQuestion(confirm, 30)).toBe(true);
  });

  it('does not match another permanent’s question, or none pending', () => {
    const confirm = { ...targetChoice(), kind: 'confirm', id: 2, sourceInstanceId: 99 } as PendingChoice;
    expect(isDeclinedMayQuestion(confirm, 30)).toBe(false);
    expect(isDeclinedMayQuestion(confirm, null)).toBe(false);
  });
});

describe('the reported sequence, through the real session', () => {
  it('asks for the target FIRST and the "may" SECOND — the order the fold covers', () => {
    const forest = card('Forest');
    const created = createGame({
      seed: 77,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => forest) },
        B: { cards: Array.from({ length: 40 }, () => forest) },
      },
      registry,
    });
    const state: GameState = created.state;
    state.players.A.hand = [];
    state.players.B.hand = [];
    const place = (def: CardDefinition, controller: PlayerId): CardInstance => {
      const inst: CardInstance = {
        instanceId: state.nextInstanceId++,
        def,
        controller,
        owner: controller,
        zone: 'battlefield',
        tapped: false,
        summoningSick: false,
        damageMarked: 0,
        markedByDeathtouch: false,
        counters: {},
      };
      state.battlefield.push(inst);
      return inst;
    };
    const closet = place(CLOSET, 'A');
    // THREE creatures, exactly as the reporter's board had (Avacyn's Pilgrim,
    // Elvish Visionary, Angel of Serenity). With only ONE legal target the
    // engine auto-answers the target question as trivial and the player is
    // asked once already — so a fixture with one creature would prove nothing
    // about the pair of prompts this fold is for.
    const creatures = ['Elvish Visionary', "Avacyn's Pilgrim", 'Gatecreeper Vine'].map((n) =>
      place(card(n), 'A'),
    );

    let session = GameSession.fromCreated(created, registry, NAMES);
    // Walk to A's end step, where the Closet triggers.
    let guard = 0;
    const asked: PendingChoice[] = [];
    while (guard++ < 120) {
      const pending = session.pendingChoice;
      if (pending) {
        asked.push(pending);
        if (asked.length >= 2) break;
        // Answer with the ENGINE's own default for whatever it asked, which is
        // exactly what the board's decline button submits.
        const next = session.answerChoice(defaultAnswerFor(pending));
        if (next.rejected) break; // a refused default means the fixture is wrong
        session = next.session;
        continue;
      }
      session = session.passPriority().session;
    }
    expect(creatures).toHaveLength(3);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    const first = asked[0]!;
    expect(first.kind).toBe('selectTargets');
    expect(first.sourceInstanceId).toBe(closet.instanceId);
    // The decline the board offers on THAT prompt is what folds the pair.
    expect(optionalTargetDecline(first, CLOSET)).toBe(`Don’t use ${CLOSET.name}`);
    if (asked[1]) {
      expect(asked[1].kind).toBe('confirm');
      expect(isDeclinedMayQuestion(asked[1], closet.instanceId)).toBe(true);
    }
  });
});
