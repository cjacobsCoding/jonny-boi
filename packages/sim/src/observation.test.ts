/**
 * THE OBSERVATION SEAM'S GUARANTEES — tested on games the engine really played,
 * not on fixtures.
 *
 * Three claims are made about this seam, and each is worth strictly nothing as an
 * intention:
 *
 *  1. **No hidden information reaches a pilot.** Proved by playing real games with
 *     the real card pool and scanning EVERY delivered observation with
 *     `@jonny-boi/protocol`'s `collectInstanceIds` against the cards actually
 *     sitting in a hand or a library at that instant. A feed that leaked the
 *     opponent's hand would be strictly worse than no feed: the pilot would appear
 *     to infer what it was in fact told, and every measured AI result built on it
 *     would be meaningless.
 *  2. **Nothing crosses a game boundary.** Proved by playing one game standalone
 *     and then the same game through the SAME pilot instance after other games,
 *     and demanding a byte-identical decision transcript.
 *  3. **Pilots that ignore the seam are unaffected.** Proved by playing the
 *     observing wrapper and the bare pilot over the same seeds and demanding
 *     identical transcripts.
 */

import { describe, expect, it } from 'vitest';
import {
  createDefaultAiRegistry,
  createRevealTrackingPilot,
  HEURISTIC_PILOT_ID,
  type GameObserver,
  type GameStartInfo,
  type Observation,
  REDACTED_OBSERVATION_TYPES,
  type OpponentReveals,
  type Pilot,
} from '@jonny-boi/ai';
import { collectInstanceIds, leakedInstanceIds } from '@jonny-boi/protocol';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  type GameAction,
  type GameEvent,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';
import { makeSeats, gameSeedFor, onPlayFor } from './matchup.js';
import { runMatch } from './match.js';
import {
  hiddenInstanceIds,
  observationOf,
  OBSERVATION_POLICY,
  REDACTION_IS_UNSPELLABLE,
} from './observation.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();

/**
 * Decks chosen so the scan crosses the mechanics that MOVE cards between hidden
 * and public zones — that is where a leak would live. UW Control draws and
 * counters, Mono-Green Ramp searches its library, Izzet Prowess cantrips.
 */
const SCANNED_MATCHUPS: ReadonlyArray<readonly [string, string]> = [
  ['Mono-Red Aggro', 'UW Control'],
  ['Izzet Prowess', 'Mono-Green Ramp'],
  ['Golgari Midrange', 'Orzhov Lifegain'],
];

/** Games per matchup in the leak scan. Enough to reach real mid/late boards. */
const SCAN_GAMES = 4;
/** Hard action cap so a stalled board fails loudly instead of hanging. */
const MAX_ACTIONS = 4000;

/** Field names that must never survive the projection, whatever the event. */
const FORBIDDEN_KEYS: readonly string[] = ['seed', 'prompt', 'answer', 'summary'];

function deckNamed(name: string) {
  const deck = SAMPLE_DECKS.find((d) => d.name === name);
  if (!deck) throw new Error(`test fixture missing: ${name}`);
  return loadDeck(deck, pool);
}

/** Every key present anywhere in a value — the structural twin of `collectInstanceIds`. */
function collectKeys(value: unknown, into: Set<string> = new Set(), seen = new Set<object>()): Set<string> {
  if (value === null || typeof value !== 'object') return into;
  if (seen.has(value)) return into;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into, seen);
    return into;
  }
  for (const [key, child] of Object.entries(value)) {
    into.add(key);
    collectKeys(child, into, seen);
  }
  return into;
}

/**
 * Drive one real game by hand, projecting every event the instant it is emitted
 * and handing the caller the live state alongside it.
 *
 * `runMatch` deliberately does not expose its state, and the leak question is a
 * question about the state AT DELIVERY TIME — a card can be public when an event
 * mentions it and hidden a few actions later (a creature bounced to hand), so a
 * scan run at the end of the game would report leaks that never happened. This
 * local driver applies the same actions in the same order as the harness.
 */
function driveGame(
  deckAName: string,
  deckBName: string,
  seed: number,
  onObservation: (observation: Observation, state: GameState, event: GameEvent) => void,
): void {
  const deckA = deckNamed(deckAName);
  const deckB = deckNamed(deckBName);
  const pilot = ai.getPilot(HEURISTIC_PILOT_ID)!;
  const pilots: Record<PlayerId, Pilot> = { A: pilot, B: pilot };
  const created = createGame({
    seed,
    decks: { A: { cards: deckA.library }, B: { cards: deckB.library } },
    registry,
  });
  let state = created.state;
  for (const event of created.events) {
    const observation = observationOf(event);
    if (observation) onObservation(observation, state, event);
  }

  const rngs: Record<PlayerId, ReturnType<typeof createRng>> = {
    A: createRng(seed * 2 + 1),
    B: createRng(seed * 2 + 2),
  };

  for (let i = 0; i < MAX_ACTIONS && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    const seat = state.priorityPlayer;
    const action = pilots[seat].chooseAction({
      view: state,
      legalActions: legal,
      rng: rngs[seat],
      registry,
      rulesConfig: DEFAULT_RULES,
    });
    const applied = applyAction(state, action, DEFAULT_RULES, registry);
    state = applied.state;
    for (const event of applied.events) {
      const observation = observationOf(event);
      if (observation) onObservation(observation, state, event);
    }
  }
}

describe('observation feed — no hidden information reaches a pilot', () => {
  it('never names a card that is in a hand or a library, over real games', () => {
    const leaks: string[] = [];
    let observations = 0;
    const typesSeen = new Set<string>();

    for (const [a, b] of SCANNED_MATCHUPS) {
      for (let g = 0; g < SCAN_GAMES; g++) {
        const seed = gameSeedFor(0xbe11e5, g);
        driveGame(a, b, seed, (observation, state, event) => {
          observations++;
          typesSeen.add(event.type);
          const leaked = leakedInstanceIds(observation, hiddenInstanceIds(state));
          if (leaked.length > 0) {
            leaks.push(
              `${a} vs ${b} seed ${seed}: '${observation.type}' (from '${event.type}') names hidden card(s) ${leaked.join(', ')}`,
            );
          }
        });
      }
    }

    // A green run must be green because nothing leaked, not because nothing ran.
    expect(observations).toBeGreaterThan(5_000);
    expect(typesSeen.size).toBeGreaterThan(15);
    expect(leaks.slice(0, 10)).toEqual([]);
  });

  it('never carries a card-authored or seed-bearing field, at any depth', () => {
    const offenders: string[] = [];
    for (const [a, b] of SCANNED_MATCHUPS) {
      driveGame(a, b, gameSeedFor(0xbe11e5, 0), (observation) => {
        const keys = collectKeys(observation);
        for (const forbidden of FORBIDDEN_KEYS) {
          if (keys.has(forbidden)) offenders.push(`'${observation.type}' carries '${forbidden}'`);
        }
      });
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('drops the seed from gameStart — the field that would hand over the whole shuffle', () => {
    const event: GameEvent = { type: 'gameStart', seed: 12345, startingPlayer: 'A' };
    const observation = observationOf(event);
    expect(observation).toEqual({ type: 'gameStart', startingPlayer: 'A' });
    expect(collectKeys(observation).has('seed')).toBe(false);
  });

  it('reports THAT a card was drawn but not WHICH', () => {
    const event: GameEvent = { type: 'drawCard', player: 'B', instanceId: 42 };
    const observation = observationOf(event);
    expect(observation).toEqual({ type: 'drawCard', player: 'B' });
    expect(collectInstanceIds(observation).size).toBe(0);
  });

  it('keeps a zone change that ends in public view and anonymises one that does not', () => {
    const toGraveyard: GameEvent = { type: 'zoneChange', instanceId: 7, from: 'hand', to: 'graveyard' };
    expect(collectInstanceIds(observationOf(toGraveyard))).toEqual(new Set([7]));

    const toHand: GameEvent = { type: 'zoneChange', instanceId: 7, from: 'battlefield', to: 'hand' };
    expect(observationOf(toHand)).toEqual({ type: 'zoneChange', from: 'battlefield', to: 'hand' });

    const toLibrary: GameEvent = { type: 'zoneChange', instanceId: 7, from: 'hand', to: 'library' };
    expect(collectInstanceIds(observationOf(toLibrary)).size).toBe(0);
  });

  it('drops a choice prompt, its answer, and the rendered summary', () => {
    const asked: GameEvent = {
      type: 'choiceAsked',
      choiceId: 1,
      chooser: 'A',
      choiceKind: 'card',
      prompt: 'Choose a card from your opponent\'s hand: Lightning Bolt, Counterspell',
      sourceInstanceId: 3,
      optionCount: 2,
    };
    expect(collectKeys(observationOf(asked)).has('prompt')).toBe(false);
    expect(observationOf(asked)).toMatchObject({ chooser: 'A', choiceKind: 'card', optionCount: 2 });

    const answered: GameEvent = {
      type: 'choiceAnswered',
      choiceId: 1,
      chooser: 'A',
      choiceKind: 'card',
      answer: { kind: 'card', instanceIds: [99] },
      summary: 'discarded Lightning Bolt',
    };
    expect(collectInstanceIds(observationOf(answered)).size).toBe(0);
    const answeredKeys = collectKeys(observationOf(answered));
    expect(answeredKeys.has('answer')).toBe(false);
    expect(answeredKeys.has('summary')).toBe(false);
  });
});

describe('observation policy table — default-deny, enforced by the compiler', () => {
  it('redacts every event type the vocabulary says must be redacted', () => {
    /*
     * The compile-time half of this guarantee lives in `observation.ts` as
     * `REDACTION_IS_UNSPELLABLE`, NOT here: `packages/sim/tsconfig.json` excludes
     * `*.test.ts` and Vitest strips types without checking them, so a
     * `@ts-expect-error` in a test file is evaluated by nothing at all. This is
     * the runtime half — that each redacted type really is wired to a projector
     * rather than waved through.
     */
    expect(REDACTION_IS_UNSPELLABLE).toHaveLength(REDACTED_OBSERVATION_TYPES.length);
    for (const type of REDACTED_OBSERVATION_TYPES) {
      expect(typeof OBSERVATION_POLICY[type], `'${type}' must be projected, not passed through`).toBe('function');
    }
  });

  it('leaves the genuinely public events passing through as themselves', () => {
    const redacted = new Set<string>(REDACTED_OBSERVATION_TYPES);
    const passthrough = Object.entries(OBSERVATION_POLICY).filter(([, policy]) => policy === 'public');
    expect(passthrough.length).toBeGreaterThan(30);
    for (const [type] of passthrough) expect(redacted.has(type)).toBe(false);
  });

  it('classifies every event type the engine actually emitted', () => {
    const unclassified = new Set<string>();
    driveGame('Mono-Red Aggro', 'UW Control', gameSeedFor(0xbe11e5, 1), (_observation, _state, event) => {
      if (!(event.type in OBSERVATION_POLICY)) unclassified.add(event.type);
    });
    expect([...unclassified]).toEqual([]);
  });

  it('passes a public event through by reference — the allocation-free path', () => {
    const event: GameEvent = { type: 'lifeChanged', player: 'A', delta: -3, to: 17 };
    expect(observationOf(event)).toBe(event);
  });
});

// ---------------------------------------------------------------------------
// Wiring: does the harness actually deliver, and does it stay inside one game?
// ---------------------------------------------------------------------------

/** Record every decision a pilot makes, so two runs can be compared byte for byte. */
function transcriptOf(decisions: readonly { readonly player: PlayerId; readonly action: GameAction }[]): string {
  return decisions.map((d) => `${d.player}:${JSON.stringify(d.action)}`).join('|');
}

function playOne(pilotA: Pilot, pilotB: Pilot, seed: number, index: number) {
  const seats = makeSeats(deckNamed('Mono-Red Aggro'), deckNamed('UW Control'), { pilotA, pilotB }, registry);
  return runMatch(seats, seed, { startingPlayer: onPlayFor(index), recordTrace: true });
}

describe('the harness delivers the feed, and only within one game', () => {
  it('shows a pilot the opponent plays it was never asked about', () => {
    let lastReveals: OpponentReveals | undefined;
    const observing = createRevealTrackingPilot(ai.getPilot(HEURISTIC_PILOT_ID)!, (r) => {
      lastReveals = r;
    });
    const result = playOne(observing, ai.getPilot(HEURISTIC_PILOT_ID)!, gameSeedFor(7, 0), 0);

    // Independently count what seat B did, straight from the recorded event log.
    const events = result.events ?? [];
    const opponentLands = events.filter((e) => e.type === 'landPlayed' && e.player === 'B').length;
    const opponentSpells = events.filter((e) => e.type === 'spellCast' && e.player === 'B').length;

    expect(opponentLands).toBeGreaterThan(0);
    expect(opponentSpells).toBeGreaterThan(0);
    expect(lastReveals).toBeDefined();
    // The tally is read at seat A's LAST decision, so it can trail the final
    // events of the game; it must never run ahead of them, and must have seen the
    // bulk of what the opponent did while A was not being asked anything.
    expect(lastReveals!.landsPlayed).toBeLessThanOrEqual(opponentLands);
    expect(lastReveals!.landsPlayed).toBeGreaterThan(0);
    expect(lastReveals!.spellsCast).toBeLessThanOrEqual(opponentSpells);
    expect(lastReveals!.cardsDrawn).toBeGreaterThan(0);
    expect([...lastReveals!.spellNames.keys()].length).toBeGreaterThan(0);
  });

  it('counts only the opponent, never itself', () => {
    let reveals: OpponentReveals | undefined;
    const observing = createRevealTrackingPilot(ai.getPilot(HEURISTIC_PILOT_ID)!, (r) => {
      reveals = r;
    });
    const result = playOne(observing, ai.getPilot(HEURISTIC_PILOT_ID)!, gameSeedFor(7, 2), 2);
    const ownSpells = new Set(
      (result.events ?? []).filter((e) => e.type === 'spellCast' && e.player === 'A').map((e) => e.instanceId),
    );
    for (const id of reveals!.knownInstanceIds) expect(ownSpells.has(id)).toBe(false);
  });

  it('starts every game from nothing, whatever games came before it', () => {
    // The failure this pins is not hypothetical: every real consumer builds ONE
    // pilot and runs MANY games through it, and the Lab shards the game grid
    // across workers by range. A belief that survived a game boundary would make
    // a paired A/B verdict depend on the worker count.
    const tallies: OpponentReveals[] = [];
    const makeObserving = () =>
      createRevealTrackingPilot(ai.getPilot(HEURISTIC_PILOT_ID)!, (r) => {
        tallies.push(r);
      });

    const targetSeed = gameSeedFor(11, 5);
    const fresh = makeObserving();
    const standalone = playOne(fresh, ai.getPilot(HEURISTIC_PILOT_ID)!, targetSeed, 5);
    const standaloneFinal = tallies[tallies.length - 1];

    tallies.length = 0;
    const reused = makeObserving();
    const opponent = ai.getPilot(HEURISTIC_PILOT_ID)!;
    playOne(reused, opponent, gameSeedFor(11, 0), 0);
    playOne(reused, opponent, gameSeedFor(11, 1), 1);
    playOne(reused, opponent, gameSeedFor(11, 2), 2);
    tallies.length = 0;
    const afterOthers = playOne(reused, opponent, targetSeed, 5);
    const afterOthersFinal = tallies[tallies.length - 1];

    expect(transcriptOf(afterOthers.decisions!)).toBe(transcriptOf(standalone.decisions!));
    expect(afterOthersFinal.cardsDrawn).toBe(standaloneFinal.cardsDrawn);
    expect(afterOthersFinal.landsPlayed).toBe(standaloneFinal.landsPlayed);
    expect(afterOthersFinal.spellsCast).toBe(standaloneFinal.spellsCast);
    expect([...afterOthersFinal.knownInstanceIds]).toEqual([...standaloneFinal.knownInstanceIds]);
  });

  it('hands a pilot a DIFFERENT observer for every game', () => {
    const seen = new Set<GameObserver>();
    const base = ai.getPilot(HEURISTIC_PILOT_ID)!;
    const counting: Pilot = {
      id: base.id,
      description: base.description,
      createGameObserver(_info: GameStartInfo) {
        const observer: GameObserver = { observe: () => {} };
        seen.add(observer);
        return observer;
      },
      chooseAction: (ctx) => base.chooseAction(ctx),
    };
    playOne(counting, base, gameSeedFor(3, 0), 0);
    playOne(counting, base, gameSeedFor(3, 1), 1);
    expect(seen.size).toBe(2);
  });

  it('leaves an unobserving pilot bit-for-bit unchanged', () => {
    const base = ai.getPilot(HEURISTIC_PILOT_ID)!;
    // None of the built-ins implement the seam — that is what makes it optional.
    for (const id of ai.pilotIds()) expect(ai.getPilot(id)!.createGameObserver).toBeUndefined();

    const observing = createRevealTrackingPilot(ai.getPilot(HEURISTIC_PILOT_ID)!);
    for (let g = 0; g < 4; g++) {
      const seed = gameSeedFor(23, g);
      const plain = playOne(base, base, seed, g);
      const watched = playOne(observing, base, seed, g);
      expect(transcriptOf(watched.decisions!)).toBe(transcriptOf(plain.decisions!));
      expect(watched.outcome).toEqual(plain.outcome);
      expect(watched.turns).toBe(plain.turns);
    }
  });
});
