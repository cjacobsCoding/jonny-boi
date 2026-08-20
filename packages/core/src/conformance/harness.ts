/**
 * The conformance harness — how a rules test is written, and how it PROVES it ran.
 *
 * Everything here drives the **real engine**: `createGame` / `generateLegalActions`
 * / `applyAction` over real `GameState`s. There is deliberately no simulated board,
 * no hand-rolled "apply" and no assertion helper that reimplements a rule — a test
 * that checks a rule against a model of the rule agrees with itself and proves
 * nothing (TESTING.md, "Test against the REAL vocabulary").
 *
 * The one thing this module adds on top of Vitest is {@link crTest}: a test whose
 * title is derived from its Comprehensive Rules reference, and which REGISTERS
 * itself in a per-file list as it is collected. Each conformance file ends with
 * {@link assertFileMatchesManifest}, which compares that list against
 * `rules-manifest.ts`. The comparison is a runtime one, inside the same module
 * graph Vitest just collected, so it cannot be satisfied by a test that was
 * deleted, renamed, skipped, or never written — the manifest claim and the
 * executed suite are the same object or the build is red.
 */

import { describe, expect, it } from 'vitest';
import type { ConformanceFile } from './rules-manifest.js';
import { coveredTitlesForFile } from './rules-manifest.js';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  STEP_ORDER,
  type CardDefinition,
  type CardInstance,
  type DeckList,
  type GameAction,
  type GameEvent,
  type GameState,
  type PlayerId,
  type Step,
} from '../index.js';
import { createEffectRegistry, type EffectPrimitive, type EffectRegistry } from '../effects.js';
import { deckOf, landDef } from '../test-fixtures.js';

// --- the CR-indexed test form ----------------------------------------------------

/** One `crTest` as it was collected: the rule it claims, and its full title. */
export interface RegisteredCrTest {
  readonly rule: string;
  readonly title: string;
}

/**
 * Every {@link crTest} collected from the file currently being loaded. A module
 * scope is a FILE scope under Vitest (each test file gets its own module graph),
 * which is exactly the granularity the manifest indexes by.
 */
const registered: RegisteredCrTest[] = [];

/**
 * Compose the canonical title of a rules test: `CR <rule> — <title>`.
 * One function, so the manifest and the suite cannot format it differently.
 */
export function crTestTitle(rule: string, title: string): string {
  return `CR ${rule} — ${title}`;
}

/**
 * Declare a conformance test for one Comprehensive Rules reference.
 *
 * `rule` is the CR number alone (`'302.6'`, `'704.5h'`); `title` says what the
 * rule requires, in the terms the engine can be observed in. The pair is what the
 * manifest stores, so a renamed test breaks the manifest check rather than
 * silently ceasing to cover its rule.
 */
export function crTest(rule: string, title: string, fn: () => void | Promise<void>): void {
  const full = crTestTitle(rule, title);
  registered.push({ rule, title });
  it(full, fn);
}

/**
 * The closing test of every conformance file: the tests this file actually
 * collected are EXACTLY the ones `rules-manifest.ts` says live here.
 *
 * Both directions matter and both are asserted:
 *   - a manifest entry with no test is a coverage claim nothing backs;
 *   - a test with no manifest entry is a rule tested but not indexed, which is how
 *     a rule-indexed corpus quietly decays back into a feature-indexed one.
 *
 * Call it at the BOTTOM of the file, after every `crTest` — registration happens
 * at collection time, so by the time Vitest runs this the list is complete.
 */
export function assertFileMatchesManifest(file: ConformanceFile): void {
  describe(`coverage manifest — ${file}`, () => {
    it('the tests this file runs are exactly the ones the manifest claims for it', () => {
      const collected = [...registered].map((t) => crTestTitle(t.rule, t.title)).sort();
      const claimed = [...coveredTitlesForFile(file)].sort();
      expect(collected).toEqual(claimed);
    });

    it('every test title in this file is unique', () => {
      const titles = registered.map((t) => crTestTitle(t.rule, t.title));
      expect(new Set(titles).size).toBe(titles.length);
    });
  });
}

// --- driving the real engine -----------------------------------------------------

/** A plain land used to pad libraries so nobody decks mid-test. */
export const FILLER_LAND = landDef('Wastes', 'C');

/** A 40-card library of {@link FILLER_LAND} — enough for any position built here. */
export function fillerDeck(): DeckList {
  return deckOf(FILLER_LAND, 40);
}

/** A fresh isolated registry; conformance tests register their own probes. */
export function registryWith(primitives: Readonly<Record<string, EffectPrimitive>>): EffectRegistry {
  const registry = createEffectRegistry();
  for (const [id, fn] of Object.entries(primitives)) registry.register(id, fn);
  return registry;
}

/** Options for {@link newGame}: decks, seed, and the effect registry to resolve with. */
export interface GameOptions {
  readonly seed?: number;
  readonly decks?: Readonly<Record<PlayerId, DeckList>>;
  readonly registry?: EffectRegistry;
}

/** A real game, created through `createGame` — never a hand-assembled `GameState`. */
export function newGame(options: GameOptions = {}): GameState {
  const { state } = createGame({
    seed: options.seed ?? 1,
    decks: options.decks ?? { A: fillerDeck(), B: fillerDeck() },
    ...(options.registry ? { registry: options.registry } : {}),
  });
  return state;
}

/** The `actionRejected` reason an action produced, or `undefined` if it was legal. */
export function rejectionOf(
  state: GameState,
  action: GameAction,
  registry?: EffectRegistry,
): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

/** Apply an action and FAIL LOUDLY if the engine rejected it. */
export function act(state: GameState, action: GameAction, registry?: EffectRegistry): GameState {
  return actWithEvents(state, action, registry).state;
}

/** {@link act}, keeping the events the action produced. */
export function actWithEvents(
  state: GameState,
  action: GameAction,
  registry?: EffectRegistry,
): { readonly state: GameState; readonly events: readonly GameEvent[] } {
  const result = applyAction(state, action, DEFAULT_RULES, registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`engine rejected ${action.kind}: ${(rejected as { reason: string }).reason}`);
  }
  return { state: result.state, events: result.events };
}

/** Pass priority once, for whoever holds it. */
export function pass(state: GameState, registry?: EffectRegistry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, registry);
}

/**
 * Pass priority until the game reaches `target`.
 *
 * The guard is a hard failure rather than a silent give-up: a helper that returns
 * a state which never reached the step under test would make every assertion after
 * it meaningless (`treadlight`'s "checks that report something other than
 * 'I didn't check'" failure, in miniature).
 */
export function advanceTo(state: GameState, target: Step, registry?: EffectRegistry): GameState {
  let s = state;
  for (let guard = 0; guard < 500; guard++) {
    if (s.step === target) return s;
    if (s.gameOver) break;
    s = pass(s, registry);
  }
  throw new Error(`never reached step ${target} (stopped at ${s.step}, turn ${s.turnNumber})`);
}

/** Pass until the given turn number begins, then stop at `target`. */
export function advanceToTurn(state: GameState, turn: number, target: Step, registry?: EffectRegistry): GameState {
  let s = state;
  for (let guard = 0; guard < 2000; guard++) {
    if (s.turnNumber === turn && s.step === target) return s;
    if (s.gameOver) break;
    s = pass(s, registry);
  }
  throw new Error(`never reached turn ${turn} ${target} (stopped at turn ${s.turnNumber} ${s.step})`);
}

/** The player who is NOT the active one — the defending player during combat. */
export function nonActive(state: GameState): PlayerId {
  return state.activePlayer === 'A' ? 'B' : 'A';
}

/** Hand priority to `player` by passing, when it is not already theirs. */
export function givePriorityTo(state: GameState, player: PlayerId, registry?: EffectRegistry): GameState {
  return state.priorityPlayer === player ? state : pass(state, registry);
}

/**
 * Put a permanent onto the battlefield directly, as a test POSITION — not as a
 * play. Everything that arrives this way is untapped, unsick and undamaged, which
 * is the board a rules test wants to start from; the rules being tested are then
 * exercised through real actions.
 */
export function putOnBattlefield(
  state: GameState,
  controller: PlayerId,
  def: CardDefinition,
  overrides: Partial<CardInstance> = {},
): CardInstance {
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
    attachedTo: null,
    counters: {},
    ...overrides,
  };
  state.battlefield.push(inst);
  return inst;
}

/** The battlefield permanent with this id, or `undefined` once it has left. */
export function onBattlefield(state: GameState, instanceId: number): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === instanceId);
}

/** Every event of a given type in a result's log. */
export function eventsNamed<K extends GameEvent['type']>(
  events: readonly GameEvent[],
  type: K,
): readonly Extract<GameEvent, { type: K }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: K }> => e.type === type);
}

/** The steps of a turn, in canonical order — re-exported so tests read one source. */
export const CANONICAL_STEPS: readonly Step[] = STEP_ORDER;

/** Whether the priority-holder is currently offered an action of this kind. */
export function offers(state: GameState, kind: GameAction['kind']): boolean {
  return generateLegalActions(state).some((a) => a.kind === kind);
}
