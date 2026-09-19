/**
 * THE SCREEN'S HALF OF A "DISCARD A CARD" COST (DESIGN §3.172) — Patrol Hound,
 * from the regenerated pool, through the real session and the proposal flow the
 * Play board drives:
 *  - the ability option carries one payer per card in hand, LABELLED BY THE
 *    CARD'S NAME (the same `costPayers` seam the sacrifice costs use, so no
 *    surface had to learn a second one);
 *  - with two cards in hand the proposal ASKS (`costPayers`), and the pick that
 *    is confirmed is the card that leaves the hand;
 *  - with one card in hand nothing is asked — a forced answer is not a decision.
 * Without this, §3.172 would be the class `40-orchestration` warns about: built,
 * tested in core, and never reachable from the board.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createGame, type CardDefinition, type CardInstance, type GameState, type PlayerId } from '@jonny-boi/core';
import { GameSession, type AbilityOption } from './session.js';
import { openProposal, proposalView, stepProposal, type Proposal, type ProposalStep } from './proposal.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const SEAT_NAMES = { A: 'You', B: 'Opponent' } as const;
const PROPOSAL_ID = 1;

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

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

function instance(state: GameState, def: CardDefinition, controller: PlayerId, zone: 'battlefield' | 'hand'): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  if (zone === 'hand') state.players[controller].hand.push(inst);
  else state.battlefield.push(inst);
  return inst;
}

function opened(step: ProposalStep): Proposal {
  if (step.kind !== 'open') throw new Error(`expected an open proposal, got ${step.kind}`);
  return step.proposal;
}

describe('§3.172 — Patrol Hound\'s "Discard a card:" on the board', () => {
  it('the option carries one payer per card in hand, labelled by the card', () => {
    let hound!: CardInstance;
    let bear!: CardInstance;
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      hound = instance(state, card('Patrol Hound'), 'A', 'battlefield');
      bear = instance(state, card('Grizzly Bears'), 'A', 'hand');
      bolt = instance(state, card('Lightning Bolt'), 'A', 'hand');
    });
    const option = session.abilityOptions().find((o) => o.instanceId === hound.instanceId) as AbilityOption;
    expect(option, "Patrol Hound's ability is offered").toBeDefined();
    expect(option.costPayers?.map((p) => [[...p.instanceIds], p.label])).toEqual([
      [[bear.instanceId], 'Grizzly Bears'],
      [[bolt.instanceId], 'Lightning Bolt'],
    ]);
  });

  it('with two cards in hand it ASKS which to discard, and the pick is what leaves the hand', () => {
    let hound!: CardInstance;
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      hound = instance(state, card('Patrol Hound'), 'A', 'battlefield');
      instance(state, card('Grizzly Bears'), 'A', 'hand');
      bolt = instance(state, card('Lightning Bolt'), 'A', 'hand');
    });
    const option = session.abilityOptions().find((o) => o.instanceId === hound.instanceId) as AbilityOption;
    let proposal = opened(openProposal(session, { kind: 'activate', option }, 'A', PROPOSAL_ID));
    const question = proposalView(proposal).question;
    expect(question?.kind).toBe('costPayers');
    if (question?.kind !== 'costPayers') return;
    expect(question.candidates).toHaveLength(2);

    proposal = opened(stepProposal(proposal, { kind: 'setCostPayers', instanceIds: [bolt.instanceId] }));
    const step = stepProposal(proposal, { kind: 'confirm' });
    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    const after = step.session.state;
    expect(after.players.A.hand.map((c) => c.def.name)).toEqual(['Grizzly Bears']);
    expect(after.players.A.graveyard.map((c) => c.instanceId)).toEqual([bolt.instanceId]);
    expect(after.stack, 'the ability is on the stack, cost paid').toHaveLength(1);
  });

  it('with ONE card in hand nothing is asked — the forced payer is taken', () => {
    let hound!: CardInstance;
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      hound = instance(state, card('Patrol Hound'), 'A', 'battlefield');
      bolt = instance(state, card('Lightning Bolt'), 'A', 'hand');
    });
    const option = session.abilityOptions().find((o) => o.instanceId === hound.instanceId) as AbilityOption;
    const proposal = opened(openProposal(session, { kind: 'activate', option }, 'A', PROPOSAL_ID));
    expect(proposalView(proposal).question).toBeNull();
    const step = stepProposal(proposal, { kind: 'confirm' });
    expect(step.kind).toBe('committed');
    if (step.kind !== 'committed') return;
    expect(step.session.state.players.A.hand).toHaveLength(0);
    expect(step.session.state.players.A.graveyard.map((c) => c.instanceId)).toEqual([bolt.instanceId]);
  });
});
