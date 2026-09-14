/**
 * THE REACH GUARD — "built, tested and imported by nothing" is the defect.
 *
 * §3.143 wave 1 shipped `lib/play/proposal.ts`: 1,111 lines, a full test file,
 * a measured two-tier census — and **no importer at all**. Everything it models
 * was therefore invisible on a screen, and two of Caleb's requests stayed
 * broken behind a green suite:
 *
 *   - **137 activated abilities on 134 pool cards were dead buttons.**
 *     `AbilityOption.costPayers` existed and `proposal.ts` read it; `PlayBoard`
 *     called `session.activateAbility(id, idx)` with no `costInstanceIds`, and
 *     `applyActivateAbility` rejects that outright for any ability printing a
 *     sacrifice cost. `proposal.test.ts` proved the machine works. Nothing
 *     could prove the board used it.
 *   - **Cancel had no single funnel**, so UX-3/4/5 and UX-7's commit half were
 *     modelled and unreachable.
 *
 * So this file asserts REACH, not shape:
 *   1. the board imports the transaction, and really calls each entry point;
 *   2. **no activation, cast or cycle bypasses it** — the class assertion, and
 *      the one that goes red the moment a dead-button call comes back;
 *   3. the board session is chosen by the proposal's own stage table, not by an
 *      ad-hoc `?? committedSession` ternary;
 *   4. the cancel affordance EXPLAINS itself instead of vanishing;
 *   5. and the funnel the board uses really does commit a real pool card's
 *      sacrifice-cost ability — (2) is what makes (5) a statement about the
 *      board rather than about a library.
 *
 * A SOURCE test for (1)–(4) because "who calls whom" is a relationship between
 * declarations, and this board has no render harness — which is precisely how
 * the gap got through.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createGame, type CardDefinition, type CardInstance, type GameState, type PlayerId } from '@jonny-boi/core';
import { GameSession, type AbilityOption } from '../../lib/play/session.js';
import { openProposal, proposalView, stepProposal } from '../../lib/play/proposal.js';

const source = readFileSync(fileURLToPath(new URL('./PlayBoard.tsx', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** The board with every comment stripped — what the code actually DOES. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ---------------------------------------------------------------------------
describe('the cast transaction is WIRED, not merely built', () => {
  /**
   * DERIVED from the import statement rather than listed here: whatever the
   * board pulls out of `proposal.js` must actually be used. An import added and
   * then not called is the wave-1 failure in miniature.
   */
  const importBlock = /import \{([^}]+)\} from '\.\.\/\.\.\/lib\/play\/proposal\.js';/.exec(source);

  it('imports the transaction at all', () => {
    expect(importBlock, 'PlayBoard no longer imports lib/play/proposal.js').not.toBeNull();
  });

  it('calls every entry point it imports — nothing is imported for decoration', () => {
    const names = (importBlock?.[1] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !part.startsWith('type '));
    expect(names.length, 'the import list is empty').toBeGreaterThanOrEqual(4);
    for (const name of names) {
      // One occurrence is the import itself; a used symbol appears again.
      const uses = code.split(name).length - 1;
      expect(uses, `${name} is imported but never called`).toBeGreaterThan(1);
    }
  });

  it('opens a proposal for all three openings — cast, activate and cycle', () => {
    for (const kind of ['cast', 'activate', 'cycle']) {
      expect(code, `no proposal is opened for a ${kind}`).toContain(`kind: '${kind}'`);
    }
  });

  it('hands `openProposal` the open COUNT, so the nesting cap is live', () => {
    // `PROPOSAL_CONFIG.maxOpenProposals` is only a gate if somebody reports how
    // many are open. Without it a second click silently replaces a half-made
    // decision instead of refusing in words.
    expect(code).toMatch(/openProposal\([^)]*proposal \? 1 : 0/);
  });
});

// ---------------------------------------------------------------------------
describe('THE DEAD-BUTTON CLASS — nothing dispatches around the transaction', () => {
  /**
   * The four session mutators that put a spell or ability on the stack. Every
   * one of them takes cost/target arguments the board used to omit, and the
   * proposal's `dispatchOpening` is now the ONLY caller. A ROW per mutator, so a
   * fifth way to announce something has to be classified here before it ships.
   */
  const ANNOUNCING_MUTATORS = [
    'activateAbility',
    'activateWithAutoTap',
    'castWithAutoTap',
    'cycleWithAutoTap',
  ] as const;

  it.each(ANNOUNCING_MUTATORS)('PlayBoard never calls session.%s itself', (mutator) => {
    // This is the assertion that would have caught the 137 dead buttons: the
    // board called `session.activateAbility(id, idx)` and there was no test in
    // the repo that could see the missing third and fourth arguments.
    expect(code, `${mutator} is dispatched outside the proposal`).not.toContain(`${mutator}(`);
  });

  it('the mutator list is not vacuous — the proposal really does call them', () => {
    const proposalSource = readFileSync(
      fileURLToPath(new URL('../../lib/play/proposal.ts', import.meta.url)),
      'utf8',
    );
    for (const mutator of ANNOUNCING_MUTATORS) {
      expect(proposalSource, `${mutator} is no longer dispatched anywhere`).toContain(`${mutator}(`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the rendered session is the proposal stage table answer', () => {
  it('reads `boardSession`, not an ad-hoc working-session ternary', () => {
    expect(code).toMatch(/const session =[^;]*boardSession/);
    // The shape it replaces. `BOARD_SESSION_BY_STAGE` states, with a reason per
    // row, when the working session may be shown; a `??` chain states nothing.
    expect(code).not.toContain('manaPicker?.working');
  });
});

// ---------------------------------------------------------------------------
describe('the cancel affordance explains itself rather than vanishing', () => {
  it('renders the proposal’s own blocked-explanation sentence', () => {
    // `REWIND_BLOCK_EXPLANATIONS` lives beside the rule it belongs to; the board
    // must render THAT and invent no copy of its own.
    expect(code).toContain('proposalPreview?.cancelBlockedExplanation');
    // Beside the control(s) AND in the standing hint — a player who is told "you
    // may back out" needs to be told when that stops being true.
    expect(code.split('cancelBlockedExplanation').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('drops a proposal whose snapshot the game has moved past, out loud', () => {
    // A proposal renders the session it opened against. `PlayView` drives the AI
    // seat and the auto-passer off its own committed session, so it can replace
    // that underneath the board — and a proposal confirmed against a stale
    // snapshot would apply the player's action to a board that has moved.
    expect(code).toContain('proposal.committed === committedSession');
  });

  it('has one cancel CONTROL, used by every pre-commit prompt', () => {
    const mounts = code.split('<ProposalCancelButton').length - 1;
    expect(mounts, 'the one cancel control is mounted nowhere').toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// The behavioural half: the funnel the board was just proved to use really does
// commit a sacrifice-cost ability that the old call shape could not.
// ---------------------------------------------------------------------------
const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
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
}

/** A board in A's precombat main, sculpted directly. */
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

describe('a real pool card with a sacrifice cost survives the board path', () => {
  /** Atog — "Sacrifice an artifact: Atog gets +2/+2 until end of turn." */
  function atogBoard(payers: number): { session: GameSession; option: AbilityOption; atogId: number } {
    let atog!: CardInstance;
    const session = sculpted((state) => {
      atog = place(state, card('Atog'), 'A');
      for (let i = 0; i < payers; i += 1) place(state, card('Ornithopter'), 'A');
    });
    const option = session.abilityOptions().find((o) => o.instanceId === atog.instanceId);
    if (!option) throw new Error("Atog's ability was not offered");
    return { session, option, atogId: atog.instanceId };
  }

  it('THE OLD BOARD CALL is still refused by the engine — the bug was real', () => {
    const { session, atogId } = atogBoard(1);
    // Exactly what `PlayBoard` used to do at its two activation call sites.
    expect(session.activateAbility(atogId, 0).rejected).toMatch(/sacrifice/i);
  });

  it('ONE legal payer is settled without a prompt, and the activation commits', () => {
    const { session, option } = atogBoard(1);
    const opened = openProposal(session, { kind: 'activate', option }, 'A', 1);
    expect(opened.kind).toBe('open');
    if (opened.kind !== 'open') return;
    expect(proposalView(opened.proposal).question).toBeNull();

    const committed = stepProposal(opened.proposal, { kind: 'confirm' });
    expect(committed.kind, 'the engine refused the board’s activation').toBe('committed');
    if (committed.kind !== 'committed') return;
    expect(committed.session.state.stack).toHaveLength(1);
  });

  it('TWO legal payers raise the cost question the board now renders', () => {
    const { session, option } = atogBoard(2);
    const opened = openProposal(session, { kind: 'activate', option }, 'A', 1);
    if (opened.kind !== 'open') throw new Error('the proposal did not open');
    const question = proposalView(opened.proposal).question;
    expect(question?.kind).toBe('costPayers');
    if (question?.kind !== 'costPayers') return;

    const chosen = [...(question.candidates[0] as { instanceIds: readonly number[] }).instanceIds];
    const answered = stepProposal(opened.proposal, { kind: 'setCostPayers', instanceIds: chosen });
    if (answered.kind !== 'open') throw new Error('answering the cost question closed the proposal');
    const committed = stepProposal(answered.proposal, { kind: 'confirm' });
    expect(committed.kind).toBe('committed');
  });

  it('the board renders that question with real card FACES, not a list of names', () => {
    // UX-8 applied to a COST: "anytime a card is asking me to choose target(s),
    // it should be showing the actual card(s)". A sacrifice is a choice too.
    const at = code.indexOf("proposalQuestion?.kind === 'costPayers'");
    expect(at, 'the cost-payer prompt is gone').toBeGreaterThan(0);
    // A window, not a brace walk: the claim is "faces are drawn HERE", and a
    // brace walk over JSX is the kind of parser that breaks on a ternary.
    const prompt = code.slice(at, at + 1500);
    expect(prompt).toContain('<CardFace');
    expect(prompt).toContain('<CardHover');
  });
});
