/**
 * §3.66 — scrubbing and forking, proven against the REAL engine rather than a
 * fixture.
 *
 * The feature only means anything if two claims hold:
 *
 *  1. SCRUBBING SHOWS THE GAME AS IT WAS. Replaying a record to action k must
 *     reproduce the exact state that game passed through at k — not an
 *     approximation, and not a state that merely looks similar.
 *  2. A FORK IS THE SAME GAME UNTIL IT ISN'T. A fork taken at k must be
 *     identical to the parent at k — same shuffle, same hands, same board —
 *     because only then is "what if I had played differently here" a fair
 *     question. That is what sharing the seed BUYS, and it is worth pinning
 *     rather than asserting in a doc comment.
 */
import { describe, expect, it } from 'vitest';
import { GameSession } from './session.js';
import { startHotseatGame } from './setup.js';
import { buildPlayRecord, rebuildFromRecord } from './persist.js';
import { forkEntry, type HistoryEntry } from './history.js';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import type { DeckChoice } from './setup.js';

const SEED = 0xc0ffee;
const NAMES = { A: 'Player 1', B: 'Computer' } as const;

function choice(name: string): DeckChoice {
  const deck = SAMPLE_DECKS.find((d) => d.name === name);
  if (!deck) throw new Error(`no sample deck "${name}"`);
  return { source: 'sample', deck };
}

/** Play a real game forward by passing priority, keeping a state snapshot per step. */
function playForward(steps: number): { session: GameSession; snapshots: string[] } {
  const started = startHotseatGame({
    choiceA: choice('Selesnya Blink'),
    choiceB: choice('Mono-Red Aggro'),
    seed: SEED,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('setup failed');
  let session = GameSession.fromCreated(started.game.created, started.game.registry, NAMES);
  const snapshots: string[] = [signature(session)];
  for (let i = 0; i < steps; i++) {
    const state = session.state;
    const action = state.pendingChoice
      ? null
      : ({ kind: 'passPriority', player: state.priorityPlayer } as const);
    if (!action) break;
    const result = session.submit(action);
    if (result.rejected) break;
    session = result.session;
    snapshots.push(signature(session));
  }
  return { session, snapshots };
}

/**
 * A state fingerprint that would notice a different shuffle: turn, step, WHO
 * HOLDS PRIORITY, life, and every zone's instance ids in order.
 *
 * Priority is in here because it is state, and leaving it out made this
 * fingerprint blind to the commonest action in the game: a pass that hands
 * priority over changes nothing else, so the divergence test below could not
 * see that anything had happened.
 */
function signature(session: GameSession): string {
  const s = session.state;
  const zones = (['A', 'B'] as const).map((seat) => {
    const p = s.players[seat];
    return [
      seat,
      p.life,
      p.hand.map((c) => c.instanceId).join(','),
      p.library.map((c) => c.instanceId).join(','),
      p.graveyard.map((c) => c.instanceId).join(','),
    ].join('|');
  });
  return [s.turn, s.step, s.activePlayer, s.priorityPlayer, ...zones, s.battlefield.map((c) => c.instanceId).join(',')].join(
    '#',
  );
}

function recordOf(session: GameSession): ReturnType<typeof buildPlayRecord> {
  return buildPlayRecord(
    {
      names: NAMES,
      choiceA: choice('Selesnya Blink'),
      choiceB: choice('Mono-Red Aggro'),
      startingPlayer: 'A',
      seed: SEED,
      mulligans: [],
      session,
      ui: { revealed: null, scrollY: 0 },
    },
    1,
  );
}

describe('scrubbing replays the game as it actually was', () => {
  const played = playForward(24);
  const record = recordOf(played.session);

  it('drove a real game far enough to be worth scrubbing', () => {
    expect(record.actions.length).toBeGreaterThan(8);
  });

  it('every scrub point reproduces that exact state, not an approximation', () => {
    for (const k of [0, 1, 5, Math.floor(record.actions.length / 2), record.actions.length]) {
      const rebuilt = rebuildFromRecord(record, k);
      expect(rebuilt.ok, `scrub to ${k}`).toBe(true);
      if (!rebuilt.ok) continue;
      expect(signature(rebuilt.game.session), `state at action ${k}`).toBe(played.snapshots[k]);
    }
  });

  it('clamps a scrub point past the end to the final state', () => {
    const rebuilt = rebuildFromRecord(record, record.actions.length + 50);
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) expect(signature(rebuilt.game.session)).toBe(signature(played.session));
  });
});

describe('a fork is the same game up to the point it diverges', () => {
  const played = playForward(24);
  const parent: HistoryEntry = {
    id: 'parent',
    record: recordOf(played.session),
    outcome: { kind: 'unfinished' },
    createdAt: 1,
    updatedAt: 1,
  };

  it('rebuilds to EXACTLY the parent state at the fork point', () => {
    const at = Math.floor(parent.record.actions.length / 2);
    const fork = forkEntry(parent, at, 'fork', 2);
    const forked = rebuildFromRecord(fork.record);
    const parentAtPoint = rebuildFromRecord(parent.record, at);
    expect(forked.ok && parentAtPoint.ok).toBe(true);
    if (!forked.ok || !parentAtPoint.ok) return;
    // Same shuffle, same hands, same board: only the future differs.
    expect(signature(forked.game.session)).toBe(signature(parentAtPoint.game.session));
  });

  it('can be played on, and then diverges from the parent', () => {
    const at = Math.floor(parent.record.actions.length / 2);
    const fork = forkEntry(parent, at, 'fork', 2);
    const rebuilt = rebuildFromRecord(fork.record);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    const before = signature(rebuilt.game.session);
    const next = rebuilt.game.session.submit({
      kind: 'passPriority',
      player: rebuilt.game.session.state.priorityPlayer,
    });
    expect(next.rejected).toBeNull();
    expect(signature(next.session)).not.toBe(before);
    // And the parent still holds its own full history, untouched.
    expect(parent.record.actions.length).toBeGreaterThan(at);
  });

  it('a fork of a fork still shares the original shuffle', () => {
    const first = forkEntry(parent, 6, 'f1', 2);
    const second = forkEntry(first, 3, 'f2', 3);
    expect(second.record.setup.seed).toBe(parent.record.setup.seed);
    const rebuilt = rebuildFromRecord(second.record);
    const parentAt3 = rebuildFromRecord(parent.record, 3);
    expect(rebuilt.ok && parentAt3.ok).toBe(true);
    if (!rebuilt.ok || !parentAt3.ok) return;
    expect(signature(rebuilt.game.session)).toBe(signature(parentAt3.game.session));
  });
});
