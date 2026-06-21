/**
 * The AI-pilot seam (DESIGN §2 "AI-strategy registry", §3.4).
 *
 * A **pilot** is a small, self-registering module that answers one question:
 * "given a read-only view of the game and the legal actions I may take right now,
 * which one do I pick?" Pilots never mutate state — they only *return* a chosen
 * `GameAction` that the engine's `applyAction` then executes. They self-register
 * by id into an `AiRegistry`, and are selected by data (an id string from a
 * deck/match config) — never hard-wired (composition over inheritance: adding a
 * pilot is a new small module + one `registerPilot` call, not a subclass).
 *
 * Determinism: a pilot is handed a seeded `Rng` (core's), so the same seed + same
 * game reproduces the same choices. No `Math.random`, no wall-clock.
 */

import type { EffectRegistry, GameAction, GameState, Rng, RulesConfig } from '@jonny-boi/core';

/**
 * A **read-only** view of the game a pilot reasons over. It is structurally the
 * engine's `GameState`, but `DeepReadonly` makes every field read-only at the
 * type level so a pilot physically cannot mutate the live state it is lent — the
 * only legal output is a returned action. (The engine still owns and clones the
 * real state in `applyAction`; the view is just a borrow.)
 */
export type PilotView = DeepReadonly<GameState>;

/**
 * A short, structured rationale a pilot may emit alongside its decision so the
 * future inspector / sim-log can surface "why did the AI do that?" — data, not
 * console spam, and not coupled to any UI. Purely optional and observational.
 */
export interface DecisionTrace {
  /** The action that was chosen. */
  readonly action: GameAction;
  /** A short human-readable reason (e.g. "burn to face — lethal"). */
  readonly reason: string;
  /**
   * The pilot's score for the chosen action, when it scored candidates. Lets a
   * log show relative confidence; omitted by pilots that don't score (e.g. random).
   */
  readonly score?: number;
}

/**
 * The decision context handed to a pilot for one choice. Bundling the view, the
 * legal actions, and the RNG keeps the `Pilot` interface to a single method and
 * leaves room to add fields (e.g. the event log) without breaking pilots.
 */
export interface DecisionContext {
  readonly view: PilotView;
  readonly legalActions: readonly GameAction[];
  /** Seeded RNG for any tie-breaking/random choice — reproducible per seed. */
  readonly rng: Rng;
  /**
   * Optional sink the pilot calls with its rationale. When present, the harness
   * collects traces for the inspector/sim-log; when absent, the pilot skips the
   * work. Observability without coupling.
   */
  readonly trace?: (trace: DecisionTrace) => void;
  /**
   * Optional **forward-model registry** for pilots that *simulate ahead* (the MCTS
   * pilot). A look-ahead pilot calls the core engine's `applyAction` to roll out
   * hypothetical lines, and `applyAction` needs the effect `registry` to resolve a
   * spell's primitives. The `ai` package does NOT depend on `cards` (which owns the
   * registry), so the harness — which *does* have it — may hand it in here for
   * **high-fidelity** rollouts.
   *
   * When ABSENT, a look-ahead pilot falls back to rolling out with an empty
   * registry: lands, mana, creatures, combat, and attacks still resolve faithfully
   * (most of the game); only spell *effects* no-op. The pilot must work either way.
   *
   * INTEGRATOR NOTE: the sim harness (`packages/sim/src/match.ts`) already holds the
   * pool's registry (`seats.registry`) and the `RulesConfig`. To get full-fidelity
   * MCTS rollouts it should pass `registry` (and `rulesConfig`) into this context at
   * its `pilot.chooseAction(...)` call. That is a small sim-side change the
   * integrator makes — this package neither edits nor depends on sim.
   */
  readonly registry?: EffectRegistry;
  /**
   * Optional rules config for look-ahead pilots, paired with `registry`. When the
   * harness simulates with a non-default `RulesConfig`, it should thread the same
   * config here so rollouts match the real game's rules (land drops, life, draws).
   * Absent ⇒ the pilot rolls out with core's `DEFAULT_RULES`.
   */
  readonly rulesConfig?: RulesConfig;
}

/**
 * An AI pilot. One method: pick a legal action against a read-only view. It must
 * only ever return something the engine will accept — an action drawn from
 * `legalActions`, or a validly-narrowed `declareAttackers`/`declareBlockers`
 * subset of an offered composite action. It must never throw and never mutate
 * the view.
 */
export interface Pilot {
  /** Stable id this pilot registers under and is selected by from data. */
  readonly id: string;
  /** A one-line description for the inspector / profile picker. */
  readonly description: string;
  /** Choose one action for the current decision. Pure w.r.t. the view. */
  chooseAction(ctx: DecisionContext): GameAction;
}

/**
 * A factory that builds a pilot. Pilots are parameterised (the random pilot needs
 * nothing; the heuristic takes tunable weights), so the registry stores factories
 * and `getPilot` instantiates on demand — keeping pilots as data-driven modules.
 */
export type PilotFactory = () => Pilot;

/**
 * The AI-strategy registry seam: pilots self-register by id, callers select by id.
 * Mirrors core's `createEffectRegistry` style (a small closure over a map), so the
 * sim/web can build a registry, register the built-ins, and resolve a pilot from a
 * config string with no hard-wiring.
 */
export interface AiRegistry {
  /** Register a pilot factory under its id. Re-registering an id replaces it. */
  registerPilot(id: string, factory: PilotFactory): void;
  /** Resolve a pilot by id, or `undefined` if no such pilot is registered. */
  getPilot(id: string): Pilot | undefined;
  /** The ids currently registered (for an inspector profile picker). */
  pilotIds(): readonly string[];
}

/** Create an empty AI registry. */
export function createAiRegistry(): AiRegistry {
  const factories = new Map<string, PilotFactory>();
  return {
    registerPilot(id, factory) {
      factories.set(id, factory);
    },
    getPilot(id) {
      const factory = factories.get(id);
      return factory ? factory() : undefined;
    },
    pilotIds() {
      return [...factories.keys()];
    },
  };
}

// --- DeepReadonly ---------------------------------------------------------------

/**
 * Recursively mark a type read-only. Used to lend pilots an immutable view of the
 * mutable `GameState` without copying it — the pilot gets the real object but the
 * compiler rejects any write to it.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
