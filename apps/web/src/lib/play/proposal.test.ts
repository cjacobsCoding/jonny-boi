/**
 * THE CAST TRANSACTION, tested as its specification (§3.143 UX-3/4/5, UX-7's
 * commit half).
 *
 * Each block below is one line of Caleb's request, turned into something that
 * can go red:
 *
 *   - opening a cast MUTATES NOTHING (UX-3);
 *   - cancelling restores a BYTE-IDENTICAL state, from any pre-commit step, and
 *     does so repeatedly (UX-3 + UX-4);
 *   - confirming lands the object on the stack and the cancel affordance is
 *     gone (UX-5);
 *   - a cast whose announcement the ENGINE is still asking about can still be
 *     backed out, and "the item should not have entered the stack anyways"
 *     (UX-7's commit half);
 *   - when the rewind stops being honest, the proposal says so WITH A REASON
 *     rather than silently keeping a button that would lie.
 *
 * Plus the regression that started the session-level work: **137 activated
 * abilities on 134 pool cards were dead buttons**, because the engine offers one
 * action per legal sacrifice payer and `AbilityOption` had nowhere to keep one.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createGame, type CardDefinition, type CardInstance, type GameEvent, type GameState, type PlayerId } from '@jonny-boi/core';
import { OBSERVATION_POLICY } from '@jonny-boi/sim';
import { GameSession, type AbilityOption, type CastOption } from './session.js';
import {
  BOARD_SESSION_BY_STAGE,
  cancelProposal,
  castChoiceOnStack,
  classifyProposalEvents,
  openProposal,
  PROPOSAL_EVENT_POLICY,
  proposalView,
  REWIND_BLOCK_EXPLANATIONS,
  rewindVerdict,
  stepProposal,
  type Proposal,
  type ProposalStep,
} from './proposal.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const PROPOSAL_ID = 1;

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

/** A session whose board and hand we sculpt directly, in A's precombat main. */
function sculpted(build: (state: GameState) => void): GameSession {
  const forest = card('Forest');
  const created = createGame({
    seed: 42,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  });
  const state = created.state;
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  build(state);
  return GameSession.fromCreated(created, registry, SEAT_NAMES);
}

function place(state: GameState, def: CardDefinition, controller: PlayerId, sick = false): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: sick,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

function toHand(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[controller].hand.push(inst);
  return inst;
}

/**
 * The WHOLE state as text — the "byte-identical" UX-3 asks for, not a hand-
 * picked handful of fields.
 *
 * Captured EAGERLY (as a string) before a proposal opens and compared to the
 * post-cancel state, so it catches the real hazard: an in-place engine path
 * writing through the session the rewind is supposed to return to. A test that
 * only compared object identity would pass on a state that had been mutated
 * underneath it. Card definitions collapse to their id because they are shared
 * by reference and enormous.
 */
function stateSignature(state: GameState): string {
  return JSON.stringify(state, (key, value) =>
    key === 'def' || key === 'printedDef' || key === 'uncopiedDef'
      ? ((value as CardDefinition | undefined)?.id ?? null)
      : value,
  );
}

/** Unwrap an `open` step, failing loudly rather than silently testing nothing. */
function opened(step: ProposalStep): Proposal {
  if (step.kind !== 'open') throw new Error(`expected an open proposal, got "${step.kind}"`);
  return step.proposal;
}

// ---------------------------------------------------------------------------
describe('UX-3 — opening a proposal mutates nothing', () => {
  it('dispatches no action: the working session IS the committed one', () => {
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      place(state, card('Grizzly Bears'), 'B');
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });
    const before = stateSignature(session.state);
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId);
    expect(option).toBeDefined();

    const proposal = opened(openProposal(session, { kind: 'cast', option: option as CastOption }, 'A', PROPOSAL_ID));
    expect(proposal.working).toBe(proposal.committed);
    expect(proposal.dispatched).toBe(false);
    expect(proposal.stage).toBe('aiming');
    // Nothing tapped, nothing on the stack, nothing gone from hand.
    expect(stateSignature(proposal.working.state)).toBe(before);
  });

  it('refuses to open a SECOND proposal rather than guessing which to restore', () => {
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      toHand(state, card('Lightning Bolt'), 'A');
    });
    const option = session.castOptions()[0] as CastOption;
    const step = openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID, 1);
    expect(step.kind).toBe('refused');
    if (step.kind !== 'refused') return;
    expect(step.proposal).toBeNull();
    expect(step.reason).toMatch(/nested proposal/i);
  });
});

// ---------------------------------------------------------------------------
describe('UX-4 — cancel restores byte-identically, from any step, repeatedly', () => {
  it('open → cancel restores the exact pre-open state', () => {
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      place(state, card('Grizzly Bears'), 'B');
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });
    const before = stateSignature(session.state);
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId) as CastOption;
    const proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));

    const step = cancelProposal(proposal);
    expect(step.kind).toBe('cancelled');
    if (step.kind !== 'cancelled') return;
    expect(step.session).toBe(session); // restored BY REFERENCE, not re-derived
    expect(stateSignature(step.session.state)).toBe(before);
  });

  it('open → choose a target → cancel still restores exactly', () => {
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      place(state, card('Grizzly Bears'), 'B');
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });
    const before = stateSignature(session.state);
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId) as CastOption;
    let proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));

    const question = proposalView(proposal).question;
    expect(question?.kind).toBe('targets');
    if (question?.kind !== 'targets') return;
    expect(question.candidates.length).toBeGreaterThan(0);
    const aim = (question.candidates[0] as { target: number | PlayerId }).target;
    proposal = opened(stepProposal(proposal, { kind: 'setTargets', targets: [aim] }));
    expect(proposalView(proposal).canConfirm).toBe(true);

    const step = cancelProposal(proposal);
    expect(step.kind).toBe('cancelled');
    if (step.kind !== 'cancelled') return;
    expect(stateSignature(step.session.state)).toBe(before);
  });

  it('open → tap mana sources → cancel un-taps them (§3.60 funding, rewound)', () => {
    let bolt!: CardInstance;
    let mountain!: CardInstance;
    const session = sculpted((state) => {
      mountain = place(state, card('Mountain'), 'A');
      place(state, card('Grizzly Bears'), 'B');
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });
    const before = stateSignature(session.state);
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId) as CastOption;
    let proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));

    proposal = opened(stepProposal(proposal, { kind: 'tapSource', instanceId: mountain.instanceId }));
    expect(proposal.stage).toBe('funding');
    // The tap is REAL inside the proposal — which is exactly why the signature
    // check below is not vacuous.
    expect(stateSignature(proposal.working.state)).not.toBe(before);
    expect(proposal.working.state.battlefield.find((c) => c.instanceId === mountain.instanceId)?.tapped).toBe(true);
    // ...and the board shows it, per BOARD_SESSION_BY_STAGE.
    expect(proposalView(proposal).boardSession).toBe(proposal.working);

    const step = cancelProposal(proposal);
    expect(step.kind).toBe('cancelled');
    if (step.kind !== 'cancelled') return;
    expect(stateSignature(step.session.state)).toBe(before);
    expect(step.session.state.battlefield.find((c) => c.instanceId === mountain.instanceId)?.tapped).toBe(false);
  });

  it('is IDEMPOTENT: twice on one proposal, and a no-op when the proposal is gone', () => {
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      place(state, card('Grizzly Bears'), 'B');
      toHand(state, card('Lightning Bolt'), 'A');
    });
    const option = session.castOptions()[0] as CastOption;
    const proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));

    const first = cancelProposal(proposal);
    const second = cancelProposal(proposal);
    expect(first.kind).toBe('cancelled');
    expect(second.kind).toBe('cancelled');
    if (first.kind !== 'cancelled' || second.kind !== 'cancelled') return;
    // The same session object both times — a second rewind is not a second undo.
    expect(second.session).toBe(first.session);
    expect(first.session).toBe(session);

    // And once the board has dropped the proposal, cancelling is a no-op rather
    // than an error (Caleb used the word "idempotently").
    expect(cancelProposal(null)).toEqual({ kind: 'noop' });
    expect(stepProposal(proposal, { kind: 'cancel' })).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
describe('UX-5 — commit is irreversible and lands on the stack', () => {
  it('confirm puts the spell on the stack and ends the proposal', () => {
    let bolt!: CardInstance;
    let bear!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      bear = place(state, card('Grizzly Bears'), 'B');
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId) as CastOption;
    let proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));
    proposal = opened(stepProposal(proposal, { kind: 'setTargets', targets: [bear.instanceId] }));

    const step = stepProposal(proposal, { kind: 'confirm' });
    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    const onStack = step.session.state.stack.filter((o) => o.kind === 'spell');
    expect(onStack).toHaveLength(1);
    expect(step.session.state.players.A.hand.find((c) => c.instanceId === bolt.instanceId)).toBeUndefined();
    // A committed step carries NO proposal, so there is no cancel affordance to
    // offer — UX-5 is enforced by the shape of the result, not by a flag.
    expect('proposal' in step).toBe(false);
  });

  it('refuses to confirm while a target is still unchosen', () => {
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      place(state, card('Grizzly Bears'), 'B');
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId) as CastOption;
    const proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));
    const step = stepProposal(proposal, { kind: 'confirm' });
    expect(step.kind).toBe('refused');
    if (step.kind !== 'refused') return;
    expect(step.reason).toMatch(/targets/i);
    expect(step.proposal).toBe(proposal); // unchanged; the player may still choose
  });
});

// ---------------------------------------------------------------------------
describe("UX-7's commit half — an unfinished ANNOUNCEMENT is still reversible", () => {
  /**
   * Dismantling Blow: {2}{W}, "Kicker {2}{U}", destroy target artifact or
   * enchantment. The engine puts it on the stack, charges {2}{W}, and only THEN
   * parks the kicker question (`awaitingCastChoice: 'kicker'`) — the tier-2
   * shape the whole snapshot exists for.
   */
  function kickerBoard(): { session: GameSession; option: CastOption; blowId: number } {
    let blow!: CardInstance;
    const session = sculpted((state) => {
      for (let i = 0; i < 3; i++) place(state, card('Plains'), 'A');
      for (let i = 0; i < 3; i++) place(state, card('Island'), 'A');
      place(state, card('Ornithopter'), 'B');
      blow = toHand(state, card('Dismantling Blow'), 'A');
    });
    const option = session.castOptions().find((o) => o.instanceId === blow.instanceId);
    if (!option) throw new Error('Dismantling Blow was not castable on this board');
    return { session, option, blowId: blow.instanceId };
  }

  it('a spell awaiting its kicker question can still be backed out, and leaves the stack EMPTY', () => {
    const { session, option, blowId } = kickerBoard();
    const before = stateSignature(session.state);
    let proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));

    const question = proposalView(proposal).question;
    expect(question?.kind).toBe('targets');
    if (question?.kind !== 'targets') return;
    const aim = (question.candidates[0] as { target: number | PlayerId }).target;
    proposal = opened(stepProposal(proposal, { kind: 'setTargets', targets: [aim] }));

    // Confirm DISPATCHES, and the engine parks the kicker question.
    proposal = opened(stepProposal(proposal, { kind: 'confirm' }));
    expect(proposal.stage).toBe('announcing');
    expect(castChoiceOnStack(proposal.working.state, blowId)).toBe('kicker');
    const view = proposalView(proposal);
    expect(view.question?.kind).toBe('engine');
    expect(view.canCancel).toBe(true);
    // Caleb: "at that point, the item should not have entered the stack
    // anyways" — so the board keeps showing the pre-cast world.
    expect(view.boardSession).toBe(proposal.committed);
    expect(view.boardSession.state.stack).toHaveLength(0);

    const step = cancelProposal(proposal);
    expect(step.kind).toBe('cancelled');
    if (step.kind !== 'cancelled') return;
    expect(step.session.state.stack).toHaveLength(0);
    expect(stateSignature(step.session.state)).toBe(before);
  });

  it('answering the kicker question through to the end commits the spell', () => {
    const { session, option, blowId } = kickerBoard();
    let proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));
    const question = proposalView(proposal).question;
    if (question?.kind !== 'targets') throw new Error('expected a target question');
    proposal = opened(
      stepProposal(proposal, {
        kind: 'setTargets',
        targets: [(question.candidates[0] as { target: number | PlayerId }).target],
      }),
    );
    proposal = opened(stepProposal(proposal, { kind: 'confirm' }));

    const step = stepProposal(proposal, { kind: 'answer', answer: { kind: 'payMana', pay: false } });
    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    expect(castChoiceOnStack(step.session.state, blowId)).toBeUndefined();
    expect(step.session.state.stack.filter((o) => o.kind === 'spell')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('the soundness invariant refuses honestly instead of lying', () => {
  const base = {
    proposer: 'A' as PlayerId,
    dispatched: true,
    proposedId: 99,
    eventVerdict: 'rewindable' as const,
    because: null,
  };
  /** A state with the proposed spell mid-announcement — the rewindable baseline. */
  function announcing(patch: (s: GameState) => void = () => {}): GameState {
    const session = sculpted(() => {});
    const state = session.state;
    state.stack = [
      {
        kind: 'spell',
        instanceId: 99,
        controller: 'A',
        card: { ...(state.players.A.library[0] as CardInstance), instanceId: 99 },
        awaitingCastChoice: 'kicker',
      } as GameState['stack'][number],
    ];
    patch(state);
    return state;
  }

  it('the baseline IS rewindable, so every refusal below is a real difference', () => {
    expect(rewindVerdict({ ...base, state: announcing() })).toEqual({ ok: true });
  });

  it('refuses when ANOTHER SEAT is being asked something', () => {
    const state = announcing((s) => {
      s.pendingChoice = {
        kind: 'confirm',
        id: 7,
        chooser: 'B',
        prompt: 'Pay the ward cost?',
        valence: 'loss',
        sourceInstanceId: 99,
        sourceName: 'Ward',
        min: 0,
        max: 1,
      };
    });
    const verdict = rewindVerdict({ ...base, state });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('anotherSeatDecides');
    expect(verdict.explanation).toBe(REWIND_BLOCK_EXPLANATIONS.anotherSeatDecides);
  });

  it('refuses while something is RESOLVING (CR 608.2 — past priority)', () => {
    const state = announcing((s) => {
      s.resolution = {
        origin: 'spell',
        controller: 'A',
        targets: [],
        effects: [],
        next: 0,
        answers: [],
        askCount: 0,
      };
    });
    const verdict = rewindVerdict({ ...base, state });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('resolving');
  });

  it('refuses once the ANNOUNCEMENT IS OVER (CR 601.2i — nothing left to ask)', () => {
    const state = announcing((s) => {
      s.stack = [];
    });
    const verdict = rewindVerdict({ ...base, state });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('announcementOver');
  });

  it('refuses when the game ENDED inside the announcement', () => {
    const state = announcing((s) => {
      s.gameOver = true;
    });
    const verdict = rewindVerdict({ ...base, state });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('gameOver');
  });

  it('refuses once information has been REVEALED, and never un-reveals it', () => {
    const revealed: GameEvent = { type: 'cardRevealed', player: 'A', instanceId: 5, name: 'Forest' };
    const verdict = rewindVerdict({
      ...base,
      state: announcing(),
      eventVerdict: 'revealed',
      because: revealed,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('revealed');
    expect(verdict.detail).toContain('cardRevealed');
  });

  it('a sealed proposal SAYS WHY rather than dropping the button silently', () => {
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      place(state, card('Grizzly Bears'), 'B');
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId) as CastOption;
    const proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));
    // Force the violating case rather than hoping today's engine produces one
    // (measured: it cannot — see PROPOSAL_EVENT_POLICY's note).
    const sealed: Proposal = {
      ...proposal,
      dispatched: true,
      stage: 'sealed',
      rewind: rewindVerdict({
        proposer: 'A',
        dispatched: true,
        proposedId: proposal.proposedId,
        state: proposal.working.state,
        eventVerdict: 'revealed',
        because: { type: 'drawCard', player: 'A', instanceId: 5 },
      }),
    };
    const view = proposalView(sealed);
    expect(view.canCancel).toBe(false);
    expect(view.cancelBlockedReason).toBe('revealed');
    expect(view.cancelBlockedExplanation).toBe(REWIND_BLOCK_EXPLANATIONS.revealed);
    expect(view.cancelBlockedExplanation).not.toBe('');
    // ...and the cancel itself refuses, with the same reason.
    const step = cancelProposal(sealed);
    expect(step.kind).toBe('refused');
    if (step.kind !== 'refused') return;
    expect(step.blocked).toBe('revealed');
    // Sealed means the board must now show what REALLY happened.
    expect(view.boardSession).toBe(sealed.working);
  });

  it('every blocked reason carries a real, player-facing sentence', () => {
    for (const [reason, text] of Object.entries(REWIND_BLOCK_EXPLANATIONS)) {
      // A SENTENCE, not a slug: the UI shows this instead of silently greying a
      // control out, so "gameOver" or "" would defeat the whole point. Length is
      // not the property — being several plain words that end in a full stop is.
      expect(text.trim().split(/\s+/).length, reason).toBeGreaterThanOrEqual(3);
      expect(text.endsWith('.'), reason).toBe(true);
      expect(text.toLowerCase(), reason).not.toBe(reason.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
describe('PROPOSAL_EVENT_POLICY is closed, total, and able to go red', () => {
  const ctx = { proposer: 'A' as PlayerId, proposedId: 42 };

  it('classifies a reveal as un-rewindable (the guard that can FAIL)', () => {
    const batch: GameEvent[] = [
      { type: 'tapped', instanceId: 1 },
      { type: 'cardRevealed', player: 'A', instanceId: 5, name: 'Forest' },
    ];
    const verdict = classifyProposalEvents(batch, ctx);
    expect(verdict.worst).toBe('revealed');
    expect(verdict.because?.type).toBe('cardRevealed');
  });

  it('exempts the PROPOSED object own move to the stack, but not another card leaving hiding', () => {
    expect(
      classifyProposalEvents([{ type: 'zoneChange', instanceId: 42, from: 'hand', to: 'stack' }], ctx).worst,
    ).toBe('rewindable');
    expect(
      classifyProposalEvents([{ type: 'zoneChange', instanceId: 7, from: 'library', to: 'graveyard' }], ctx).worst,
    ).toBe('revealed');
    // Public → public moves nothing anybody did not already know.
    expect(
      classifyProposalEvents([{ type: 'zoneChange', instanceId: 7, from: 'battlefield', to: 'graveyard' }], ctx).worst,
    ).toBe('rewindable');
  });

  it("treats the proposer's own cast-time questions as rewindable and the opponent's as hands-off", () => {
    const asked = (chooser: PlayerId): GameEvent => ({
      type: 'choiceAsked',
      choiceId: 1,
      chooser,
      choiceKind: 'payMana',
      prompt: 'Pay the kicker?',
      sourceInstanceId: 42,
      optionCount: 2,
    });
    expect(classifyProposalEvents([asked('A')], ctx).worst).toBe('rewindable');
    expect(classifyProposalEvents([asked('B')], ctx).worst).toBe('handsOff');
  });

  it('an empty batch is rewindable and names nothing', () => {
    expect(classifyProposalEvents([], ctx)).toEqual({ worst: 'rewindable', because: null });
  });

  /**
   * THE TOTALITY GUARD. `OBSERVATION_POLICY` is a mapped type over the same
   * `GameEvent['type']`, so its runtime key set IS the engine's event list —
   * which makes this a check that an event added to core reaches BOTH tables in
   * the same edit, at runtime, where Vitest can see it. (The compile-time half
   * lives in the mapped type in shipped source, because tsconfig excludes
   * `*.test.ts` and Vitest strips types.)
   */
  it('has exactly one row per engine event — no more, no fewer', () => {
    expect(Object.keys(PROPOSAL_EVENT_POLICY).sort()).toEqual(Object.keys(OBSERVATION_POLICY).sort());
  });

  /**
   * THE BLOCKING SET IS A DECLARED LIST, and this fails in BOTH directions: a
   * row quietly turned from `'rewindable'` to blocking shows up here, and so
   * does a row that stopped blocking. Every entry is argued for in the table's
   * own comments; this is the pin that stops the argument being edited away.
   */
  it('the events that block a rewind are exactly this reviewed list', () => {
    const declared: Readonly<Record<string, string>> = {
      // Somebody now knows something a cancel cannot un-know.
      gameStart: 'revealed', // the seed is the whole game
      drawCard: 'revealed',
      cardsLookedAt: 'revealed',
      cardsMilled: 'revealed',
      cardRevealed: 'revealed',
      pileBottomed: 'revealed',
      madnessWindowOpened: 'revealed',
      cascadeWindowOpened: 'revealed',
      rippleWindowOpened: 'revealed',
      cardSuspended: 'revealed',
      // Another seat has a decision.
      choiceAbandoned: 'handsOff',
      // §3.178 — a repeat replays the other seat's recorded passes.
      comboRepeated: 'handsOff',
      // Payload-conditional: it depends who, or which card.
      zoneChange: 'conditional',
      choiceAsked: 'conditional',
      choiceAnswered: 'conditional',
      choiceAutoAnswered: 'conditional',
      priorityPassed: 'conditional',
    };
    const actual = Object.fromEntries(
      Object.entries(PROPOSAL_EVENT_POLICY)
        .filter(([, row]) => row !== 'rewindable')
        .map(([key, row]) => [key, typeof row === 'function' ? 'conditional' : row]),
    );
    expect(actual).toEqual(declared);
  });

  /**
   * The ONE relation between the two tables that genuinely holds: if a
   * SPECTATOR may not be told an event plainly — `OBSERVATION_POLICY` hands it
   * a redacting function or `'private'` — then a proposal may not assume it was
   * invisible either. The converse is deliberately NOT asserted: `cardsLookedAt`
   * is `'public'` there (a count everyone sees) and blocking here (the PROPOSER
   * now knows their library's top), and both readings are right.
   */
  it('never treats as freely rewindable something a spectator may not be told plainly', () => {
    for (const key of Object.keys(OBSERVATION_POLICY) as (keyof typeof OBSERVATION_POLICY)[]) {
      if (OBSERVATION_POLICY[key] === 'public') continue;
      expect(PROPOSAL_EVENT_POLICY[key], key).not.toBe('rewindable');
    }
  });
});

// ---------------------------------------------------------------------------
describe('the view is derived from one reading, so nothing can fork', () => {
  it("'sealed' means exactly 'the rewind is refused' — never two answers", () => {
    const session = sculpted((state) => {
      place(state, card('Mountain'), 'A');
      place(state, card('Grizzly Bears'), 'B');
      toHand(state, card('Lightning Bolt'), 'A');
    });
    const option = session.castOptions()[0] as CastOption;
    const proposal = opened(openProposal(session, { kind: 'cast', option }, 'A', PROPOSAL_ID));
    expect(proposal.stage === 'sealed').toBe(!proposal.rewind.ok);
    expect(proposalView(proposal).canCancel).toBe(proposal.rewind.ok);
  });

  it('BOARD_SESSION_BY_STAGE has a row for every stage and only the two answers', () => {
    expect(Object.keys(BOARD_SESSION_BY_STAGE).sort()).toEqual(['aiming', 'announcing', 'funding', 'sealed']);
    for (const value of Object.values(BOARD_SESSION_BY_STAGE)) {
      expect(['committed', 'working']).toContain(value);
    }
  });
});

// ---------------------------------------------------------------------------
describe('REGRESSION — a "Sacrifice a <noun>" ability is no longer a dead button', () => {
  /**
   * Atog: "Sacrifice an artifact: Atog gets +2/+2 until end of turn." The engine
   * offers ONE action per legal payer, carrying `costInstanceIds`, and refuses an
   * activation that names none — measured against the real engine:
   *   offer  → {kind:'activateAbility', …, costInstanceIds:[<artifact>]}
   *   bare   → actionRejected "Atog's ability needs 1 legal permanent(s) to sacrifice"
   * The board folded every offer into one option that carried no payer, so the
   * click died on that rejection. 137 abilities on 134 pool cards, all dead.
   */
  function atogBoard(): { session: GameSession; option: AbilityOption; atogId: number; foodId: number } {
    let atog!: CardInstance;
    let food!: CardInstance;
    const session = sculpted((state) => {
      atog = place(state, card('Atog'), 'A');
      food = place(state, card('Ornithopter'), 'A');
    });
    const option = session.abilityOptions().find((o) => o.instanceId === atog.instanceId);
    if (!option) throw new Error("Atog's ability was not offered");
    return { session, option, atogId: atog.instanceId, foodId: food.instanceId };
  }

  it('THE BUG: activating without naming a payer is still refused by the engine', () => {
    const { session, atogId } = atogBoard();
    const result = session.activateAbility(atogId, 0);
    expect(result.rejected).toMatch(/sacrifice/i);
    expect(result.session).toBe(session); // and the board is untouched
  });

  it('THE FIX: the option now carries the legal payers the engine offered', () => {
    const { option, foodId } = atogBoard();
    expect(option.costPayers).toBeDefined();
    expect(option.costPayers?.map((p) => [...p.instanceIds])).toEqual([[foodId]]);
    expect(option.costPayers?.[0]?.label).toBe('Ornithopter');
  });

  it('a proposal for it commits, and the sacrifice really happens', () => {
    const { session, option, foodId } = atogBoard();
    const proposal = opened(openProposal(session, { kind: 'activate', option }, 'A', PROPOSAL_ID));
    // ONE legal payer is not a decision (the engine's own rule for a forced
    // answer), so there is nothing left to ask.
    expect(proposalView(proposal).question).toBeNull();

    const step = stepProposal(proposal, { kind: 'confirm' });
    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    expect(step.session.state.battlefield.find((c) => c.instanceId === foodId)).toBeUndefined();
    expect(step.session.state.players.A.graveyard.some((c) => c.instanceId === foodId)).toBe(true);
    expect(step.session.state.stack).toHaveLength(1);
  });

  it('with TWO legal payers it ASKS, and cancelling still restores exactly', () => {
    let atog!: CardInstance;
    const session = sculpted((state) => {
      atog = place(state, card('Atog'), 'A');
      place(state, card('Ornithopter'), 'A');
      place(state, card('Ornithopter'), 'A');
    });
    const before = stateSignature(session.state);
    const option = session.abilityOptions().find((o) => o.instanceId === atog.instanceId) as AbilityOption;
    expect(option.costPayers).toHaveLength(2);

    let proposal = opened(openProposal(session, { kind: 'activate', option }, 'A', PROPOSAL_ID));
    const question = proposalView(proposal).question;
    expect(question?.kind).toBe('costPayers');
    if (question?.kind !== 'costPayers') return;
    expect(question.candidates).toHaveLength(2);

    // Change your mind before confirming: nothing has happened.
    const cancelled = cancelProposal(proposal);
    expect(cancelled.kind).toBe('cancelled');
    if (cancelled.kind !== 'cancelled') return;
    expect(stateSignature(cancelled.session.state)).toBe(before);

    // ...or pick one and go through.
    const chosen = [...(question.candidates[1] as { instanceIds: readonly number[] }).instanceIds];
    proposal = opened(stepProposal(proposal, { kind: 'setCostPayers', instanceIds: chosen }));
    const step = stepProposal(proposal, { kind: 'confirm' });
    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    expect(step.session.state.players.A.graveyard.map((c) => c.instanceId)).toEqual(chosen);
  });

  /**
   * THE CLASS GUARD. Not "Atog works" but "no ability the engine offers with a
   * payer reaches the board without one". If a new cost axis appears on
   * `activateAbility`, or the fold stops carrying payers, this fails for every
   * card at once rather than for the one somebody happened to test.
   */
  it('every offered payer reaches its option — no offer loses its cost', () => {
    let atog!: CardInstance;
    const session = sculpted((state) => {
      atog = place(state, card('Atog'), 'A');
      place(state, card('Ornithopter'), 'A');
      place(state, card('Mox Ruby'), 'A');
    });
    const offered = new Map<string, Set<string>>();
    for (const action of session.legalActions()) {
      if (action.kind !== 'activateAbility') continue;
      const ids = action.costInstanceIds;
      if (ids === undefined || ids.length === 0) continue;
      const key = `${action.instanceId}:${action.abilityIndex}`;
      const set = offered.get(key) ?? new Set<string>();
      set.add([...ids].join(','));
      offered.set(key, set);
    }
    expect(offered.size, 'the board must actually offer a sacrifice cost here').toBeGreaterThan(0);
    for (const [key, payerKeys] of offered) {
      const [instanceId, abilityIndex] = key.split(':').map(Number);
      const option = session
        .abilityOptions()
        .find((o) => o.instanceId === instanceId && o.abilityIndex === abilityIndex);
      expect(option, key).toBeDefined();
      expect(new Set((option?.costPayers ?? []).map((p) => [...p.instanceIds].join(','))), key).toEqual(payerKeys);
    }
    expect(atog.instanceId).toBeGreaterThan(0);
  });
});
