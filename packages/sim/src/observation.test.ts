/**
 * THE OBSERVATION SEAM'S GUARANTEES — tested on games the engine really played,
 * not on fixtures.
 *
 * Three claims are made about this seam, and each is worth strictly nothing as an
 * intention:
 *
 *  1. **No card the table has not seen is ever named to a pilot.** Proved by
 *     playing FULL-POOL, MECHANIC-ANCHORED games and checking every delivered
 *     observation with the scanner in `observation.ts` — which asks core's
 *     `instanceIdsNamedBy` "which cards does this name?", so it sees
 *     `sourceInstanceId`, `attackTargets`' keys and an answer's `instanceIds` as
 *     readily as `instanceId`. A feed that leaked the opponent's hand would be
 *     strictly worse than no feed: the pilot would appear to infer what it was in
 *     fact told, and every measured AI result built on it would be meaningless.
 *  2. **Nothing crosses a game boundary.** Proved by playing one game standalone
 *     and then the same game through the SAME pilot instance after other games,
 *     and demanding a byte-identical decision transcript.
 *  3. **Pilots that ignore the seam are unaffected.** Proved by playing the
 *     observing wrapper and the bare pilot over the same seeds and demanding
 *     identical transcripts.
 *
 * ## ⚠️ WHY THIS FILE DOES NOT USE THE GAUNTLET DECKS ANY MORE
 * It used to scan three curated matchups (`Mono-Red Aggro` vs `UW Control` and
 * friends). It passed on every build since it was written, and the card list is
 * exactly why: **no curated
 * deck plays a buyback spell**, so the one case where a public event legitimately
 * names a card that has just landed in a hand never occurred here — it was found
 * by the full-pool soak instead, at seed 539293510. A guarantee whose test only
 * plays a fifth of the pool is a guarantee about that fifth.
 *
 * So claim 1 is now proved over the soak's generated decks, which anchor on every
 * mechanic the pool prints (`soak-decks.ts`), and the run ASSERTS that every one
 * of them fired. If the deck generator ever stops reaching a mechanic, this file
 * fails rather than quietly narrowing.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  createDefaultAiRegistry,
  createRevealTrackingPilot,
  DEFAULT_PILOT_ID,
  HEURISTIC_PILOT_ID,
  type GameObserver,
  type GameStartInfo,
  type Observation,
  REDACTED_OBSERVATION_TYPES,
  type OpponentReveals,
  type Pilot,
} from '@jonny-boi/ai';
import { collectInstanceIds } from '@jonny-boi/protocol';
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
  createObservationLeakScanner,
  observationOf,
  OBSERVATION_POLICY,
  REDACTION_IS_UNSPELLABLE,
} from './observation.js';
import { SOAK_INVARIANTS, SOAK_MECHANIC_SEED_ATTEMPTS, type SoakMechanicId } from './soak-config.js';
import { formatSoakReport, formatViolations, runSoak, type SoakReport } from './soak.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();

/** Mixed (unanchored) games played alongside the anchored ones, as a control. */
const SCAN_MIXED_GAMES = 12;

/** The scan's own base seed — distinct from the soak's, so the two play different games. */
const SCAN_BASE_SEED = 0xbe11e5;

/** Hard action cap so a stalled board fails loudly instead of hanging. */
const MAX_ACTIONS = 4000;

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
 * Drive one real game by hand, projecting every event the instant it is emitted.
 *
 * Kept only for the policy-table coverage check below (which asks WHICH EVENT
 * TYPES a real game emits, not what they carry). The leak scan itself runs
 * through `runSoak`, over generated full-pool decks — see the header.
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

/**
 * THE SCAN. One soak run, every game scanned, shared by the block below.
 *
 * In a `beforeAll` rather than at module scope because module-scope work is
 * COLLECTION to Vitest: the cost would be billed where it is invisible, and a
 * throw would fail the whole FILE with a collection error instead of one named
 * test.
 */
let scan: SoakReport;

/**
 * The mechanics that MOVE A CARD ACROSS THE HIDDEN/PUBLIC BOUNDARY — where a
 * redaction bug can actually live, and precisely what the curated gauntlet decks
 * did not play.
 *
 * Named individually rather than trusted to `inertMechanics` alone, because the
 * point of this list is documentary: these are the shapes a reader should check
 * first when changing `OBSERVATION_POLICY`. Typed as `SoakMechanicId`, so
 * renaming one in `soak-config.ts` is a compile error here rather than a test
 * that silently stops asserting.
 */
const BOUNDARY_MECHANICS: readonly SoakMechanicId[] = [
  'buyback', // a spell that resolves back into its OWNER'S HAND — hole 2
  'madness', // hand → exile, then cast from exile
  'cycling', // hand → graveyard as a cost, plus a draw
  'discard-cost', // hand → graveyard as an activation cost (§3.172), the card named on the action
  'mill', // library → graveyard
  'scry', // the top of a library LOOKED AT
  'surveil', // the same look, with a graveyard destination
  'graveyard-recursion', // graveyard → hand: the Gravedigger case
  'tutor-route', // a search of the library itself
  'flashback-cast', // a card cast from a public zone it was put into
];

describe('observation feed — no card the table has not seen reaches a pilot', () => {
  beforeAll(() => {
    scan = runSoak({
      pool,
      registry,
      pilot: ai.getPilot(DEFAULT_PILOT_ID)!,
      // The anchored half is the point: one matchup per mechanic the pool
      // prints. The mixed games are the control — decks nobody aimed.
      mixedGames: SCAN_MIXED_GAMES,
      anchorAttempts: SOAK_MECHANIC_SEED_ATTEMPTS,
      baseSeed: SCAN_BASE_SEED,
      // EVERY game, not the soak's sampling stride: this file is the guarantee's
      // own test, and a sampled guarantee is a sampled guarantee.
      leakScanEvery: 1,
      // The cloning-vs-in-place replay is `soak.test.ts`'s job and doubles the
      // cost of a sampled game; nothing here depends on it.
      equivalenceEvery: 0,
    });
  });

  it('never names a card the table has never seen, over full-pool games', () => {
    const leaks = scan.violations.filter((v) => v.invariant === SOAK_INVARIANTS.noObservationLeak);
    expect(leaks.length, `\n${formatViolations(leaks)}\n`).toBe(0);
  });

  it('looked at enough observations for that to mean something', () => {
    // "No leaks" and "nothing scanned" are the same green. This is the only
    // thing standing between a pilot and the opponent's decklist, so a run that
    // quietly scanned nothing must fail rather than reassure.
    expect(scan.leakScanObservations, `\n${formatSoakReport(scan)}\n`).toBeGreaterThan(50_000);
    expect(scan.games).toBeGreaterThan(SCAN_MIXED_GAMES);
  });

  it('scanned games that actually PLAY the mechanics a leak would hide in', () => {
    // The curated-matchup failure, made impossible to reintroduce. If the deck
    // generator stops reaching buyback, this fails — rather than the scan going
    // quietly green over games where the interesting case cannot occur.
    const missing = BOUNDARY_MECHANICS.filter((id) => (scan.mechanicGames.get(id) ?? 0) === 0);
    expect(missing, `\n${formatSoakReport(scan)}\n`).toEqual([]);
  });

  it('fired EVERY mechanic the pool prints while scanning', () => {
    // The general form of the test above: whatever ships next is scanned too,
    // without anybody remembering to add it to a list.
    expect(scan.inertMechanics, `\n${formatSoakReport(scan)}\n`).toEqual([]);
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

/**
 * THE SCANNER'S OWN RULES, on hand-built windows.
 *
 * The soak run above proves the guarantee on real games; these prove that the
 * scanner would have SAID SO. Both are needed — a scanner that reports nothing
 * makes any run green, and that is the failure this whole branch exists to close.
 */
describe('the leak scanner reports what it is supposed to report', () => {
  const hiddenState = (handIds: readonly number[], libraryIds: readonly number[] = []): GameState =>
    ({
      players: {
        A: {
          hand: handIds.map((instanceId) => ({ instanceId })),
          library: libraryIds.map((instanceId) => ({ instanceId })),
        },
        B: { hand: [], library: [] },
      },
    }) as unknown as GameState;

  /** Run one scanner over a scripted sequence of `[observations, state]` windows. */
  const run = (windows: ReadonlyArray<readonly [readonly Observation[], GameState]>): string[] => {
    const reports: string[] = [];
    const scanner = createObservationLeakScanner((d) => reports.push(d));
    for (const [observations, state] of windows) {
      for (const observation of observations) scanner.observe(observation);
      scanner.flush(state);
    }
    return reports;
  };

  it('CATCHES a card that has only ever sat in a hand — the CR 514.1 cleanup-discard leak', () => {
    // The exact shape of hole 1: a public-ish `choiceAsked` whose SOURCE points
    // at a card in the discarding player's hand. Note the key is
    // `sourceInstanceId`, which the pre-fix scan could not see at all.
    const state = hiddenState([55]);
    const asked = { type: 'choiceAsked', choiceId: 1, chooser: 'A', choiceKind: 'selectCards', sourceInstanceId: 55, optionCount: 1 } as unknown as Observation;
    expect(run([[[], state], [[asked], state]])).toEqual([
      'observation choiceAsked names #55, a card the table has never seen',
    ]);
  });

  /**
   * §3.119 — a REVEAL makes its subject seen without moving it.
   *
   * Caught by the soak, not by a unit test, the first time: Goblin Guide reveals
   * the defending player's top card, and a revealed NON-land stays on top —
   * displayed to both players and still in the library. The scanner reported the
   * card's own printed effect as a leak.
   */
  it('ALLOWS a reveal of a card that stays in its hidden zone, and every later mention of it', () => {
    const state = hiddenState([87]);
    const revealed = {
      type: 'cardRevealed',
      player: 'B',
      instanceId: 87,
      name: 'Wall of Fire',
      fromZone: 'library',
      sourceInstanceId: 1,
      matched: false,
    } as unknown as Observation;
    // The reveal itself is legitimate…
    expect(run([[[], state], [[revealed], state]])).toEqual([]);
    // …and so is naming the same card afterwards, while it is STILL in the
    // library: the table has seen it, which is the scanner's actual rule.
    const later = { type: 'stackResolved', instanceId: 87, name: 'Wall of Fire' } as unknown as Observation;
    expect(run([[[], state], [[revealed], state], [[later], state]])).toEqual([]);
  });

  it('still CATCHES a card merely NAMED by a non-reveal while it sits in a library', () => {
    // The other half: without a reveal, the same id in the same zone is a leak.
    const state = hiddenState([87]);
    const later = { type: 'stackResolved', instanceId: 87, name: 'Wall of Fire' } as unknown as Observation;
    expect(run([[[], state], [[later], state]])).toEqual([
      'observation stackResolved names #87, a card the table has never seen',
    ]);
  });

  it('CATCHES an id hidden inside a list, a map key, and a nested object', () => {
    const state = hiddenState([55]);
    const cases: ReadonlyArray<readonly [string, Observation]> = [
      ['targets list', { type: 'triggerTargetsChosen', sourceInstanceId: 1, controller: 'A', label: 'x', targets: [55] }],
      ['attackTargets key', { type: 'attackersDeclared', attackers: [], attackTargets: { 55: 'B' } }],
      ['blocks pair', { type: 'blockersDeclared', blocks: [{ blocker: 55, attacker: 1 }] }],
    ] as unknown as ReadonlyArray<readonly [string, Observation]>;
    const silent = cases.filter(([, o]) => run([[[], state], [[o], state]]).length === 0).map(([name]) => name);
    expect(silent, 'the scanner walked straight past these').toEqual([]);
  });

  it('does NOT report a card that was on the battlefield a moment ago', () => {
    // A land played from hand is named by two entirely public observations and
    // was in a hand a microsecond earlier. Scanning against the PRE-action state
    // reports every land drop in the game; this is that mistake, pinned.
    const before = hiddenState([55]);
    const after = hiddenState([]);
    const played = { type: 'landPlayed', player: 'A', instanceId: 55 } as Observation;
    expect(run([[[], before], [[played], after]])).toEqual([]);
  });

  it('does NOT report a bought-back spell, in its window OR many windows later', () => {
    // HOLE 2, both halves, modelled exactly as the engine plays it (seed
    // 3246281276): Elvish Fury is cast out of a hand — and sits on the STACK for
    // a whole decision, which is where the table sees it — then resolves back
    // into that hand, and at cleanup MUCH later the pump it left behind expires
    // naming it a third time. None of the three tells a pilot anything.
    const inHand = hiddenState([70]);
    const onStack = hiddenState([]); // on the stack: not in a hand, not in a library
    const cast = { type: 'spellCast', player: 'B', instanceId: 70, name: 'Elvish Fury', castTypes: ['instant'] } as Observation;
    const resolved = { type: 'stackResolved', instanceId: 70, name: 'Elvish Fury' } as Observation;
    const expired = { type: 'continuousEffectExpired', targetInstanceId: 90, sourceInstanceId: 70, duration: 'endOfTurn' } as Observation;
    expect(
      run([
        [[], inHand],
        [[cast], onStack],
        [[resolved], inHand],
        [[], inHand],
        [[expired], inHand],
      ]),
    ).toEqual([]);
  });

  it('and it is the trip through the STACK that makes that legal, not the event type', () => {
    // The positive control for the test above, and the reason this file needs no
    // "…except stackResolved" exemption: delete the window where the card was on
    // the stack and the very same observations become a leak. Nothing about
    // `stackResolved` is privileged — being seen is.
    const inHand = hiddenState([70]);
    const resolved = { type: 'stackResolved', instanceId: 70, name: 'Elvish Fury' } as Observation;
    const expired = { type: 'continuousEffectExpired', targetInstanceId: 90, sourceInstanceId: 70, duration: 'endOfTurn' } as Observation;
    expect(run([[[], inHand], [[resolved], inHand], [[expired], inHand]])).toEqual([
      'observation stackResolved names #70, a card the table has never seen',
      'observation continuousEffectExpired names #70, a card the table has never seen',
    ]);
  });

  it('a card seen ONCE stays seen — the memory is the whole game, not one window', () => {
    // "Hidden before the window as well as after" is a one-window approximation
    // and the Elvish Fury walks straight through it: by the time its pump
    // expires, the card has been sitting in a hand for many windows. This is the
    // difference between the two rules, pinned.
    const inHand = hiddenState([70]);
    const onStack = hiddenState([]);
    const expired = { type: 'continuousEffectExpired', targetInstanceId: 90, sourceInstanceId: 70, duration: 'endOfTurn' } as Observation;
    const windows: Array<readonly [readonly Observation[], GameState]> = [[[], inHand], [[], onStack]];
    for (let i = 0; i < 20; i++) windows.push([[], inHand]);
    windows.push([[expired], inHand]);
    expect(run(windows)).toEqual([]);
  });

  it('reports a forbidden field at any depth', () => {
    const state = hiddenState([]);
    const leaky = { type: 'choiceAsked', choiceId: 1, chooser: 'A', choiceKind: 'selectCards', prompt: 'Discard Lightning Bolt?', sourceInstanceId: 1, optionCount: 2 } as unknown as Observation;
    expect(run([[[leaky], state]])).toEqual(['observation choiceAsked carries a forbidden field "prompt"']);
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
