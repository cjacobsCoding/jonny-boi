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
import type { GameObserver, GameStartInfo } from './observation.js';

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
 *
 * `TObserver` is the pilot's own per-game observer type (see
 * {@link Pilot.createGameObserver}); it defaults to the bare {@link GameObserver}
 * so every existing pilot, and every existing `DecisionContext` annotation, is
 * unchanged.
 */
export interface DecisionContext<TObserver extends GameObserver = GameObserver> {
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
  /**
   * **The observation seam's read side.** The per-game observer this pilot
   * returned from {@link Pilot.createGameObserver}, carrying everything the
   * harness has shown it since the game began — including the actions and events
   * this pilot did not initiate, which `chooseAction` alone can never see
   * (it is only ever called while this seat holds priority).
   *
   * Absent when the pilot declined to create one, and absent in any harness that
   * does not drive the seam. A pilot that reads it must therefore tolerate
   * `undefined` and simply play as it did before — which is what makes the seam
   * optional rather than a new requirement on every pilot.
   */
  readonly observer?: TObserver;
}

/**
 * An AI pilot. One method: pick a legal action against a read-only view. It must
 * only ever return something the engine will accept — an action drawn from
 * `legalActions`, or a validly-narrowed `declareAttackers`/`declareBlockers`
 * subset of an offered composite action. It must never throw and never mutate
 * the view.
 */
export interface Pilot<TObserver extends GameObserver = GameObserver> {
  /** Stable id this pilot registers under and is selected by from data. */
  readonly id: string;
  /** A one-line description for the inspector / profile picker. */
  readonly description: string;
  /** Choose one action for the current decision. Pure w.r.t. the view. */
  chooseAction(ctx: DecisionContext<TObserver>): GameAction;
  /**
   * **The observation seam's write side — optional.** Return a fresh observer and
   * the harness will feed it every public thing that happens in this one game,
   * whichever seat caused it, then hand it back on every `DecisionContext`.
   * Return nothing (or omit the method entirely, as all four built-in pilots do)
   * and the harness skips the whole path: an unobserving pilot is bit-for-bit
   * unaffected by this seam.
   *
   * **Called once per game, and the result must be fresh every time.** Its
   * lifetime is the game's — see {@link GameObserver} for why that is the load-
   * bearing property and not a detail: a pilot instance is reused across hundreds
   * of games and sharded across workers, so any belief that outlives a game makes
   * a paired A/B verdict depend on how the work was divided up.
   */
  createGameObserver?(info: GameStartInfo): TObserver | undefined;
  /**
   * **The fast-pass seam — optional, and a PROMISE when it returns true.**
   *
   * Answering `true` means: *whatever the legal menu turns out to contain, I am
   * going to pass priority.* A harness may then skip building the menu at all
   * and apply the pass directly, which is the point — `generateLegalActions` is
   * ~20% of a sim run, and measurement says the heuristic passes **81.7% of the
   * 592 decision windows in a game** (`packages/sim/bench/window-stats.mjs`).
   * Most of that work is enumerated, scored and thrown away.
   *
   * ⚠️ A WRONG `true` SILENTLY MAKES THE PILOT PLAY WORSE, and every recorded
   * win-rate with it. It is not an optimisation hint that can be a bit off: the
   * action is taken without anybody checking. So the contract is one-sided —
   * `false` (or omitting the method) is ALWAYS safe and simply means "ask me
   * properly", while `true` must be provable from the state alone.
   *
   * The guard is `packages/ai/src/fast-pass.test.ts`: it plays whole games with
   * the seam on and off and requires the transcripts to be identical, action for
   * action. A gate that ever lies fails there rather than in a win rate nobody
   * can explain six months later.
   *
   * `view` is the same read-only state `chooseAction` would receive.
   */
  willPassPriority?(view: GameState, rulesConfig?: RulesConfig): boolean;
  /**
   * **The plan seam — optional, and a PROMISE about the actions after the first.**
   *
   * The first element is this decision, exactly what {@link chooseAction} would
   * have returned. Every element after it is an action the pilot promises it
   * WOULD choose at the next window, and the next, given each one is accepted
   * and nothing else moves — the remaining taps that fund the spell it is
   * pursuing, as one committed line instead of N decisions. A harness may then
   * apply the continuation directly, without building a menu or asking again.
   * (The cast at the end is NOT promised: the pilot re-decides it against the
   * floating pool, and does not always cast what it tapped for — see
   * `pursueSpell` for the case that taught this.)
   *
   * Why it pays: a tap toward a spell costs a full priority decision (score the
   * hand, plan the mana), and the pilot is asked again after every single tap,
   * re-deriving the same goal and the same plan. Measured (`bench/pilot-decide-
   * bench.mjs`), 18% of the windows the fast pass cannot take are exactly these
   * continuations.
   *
   * ⚠️ THE SAME ONE-SIDED CONTRACT AS THE FAST PASS. A continuation that differs
   * from what the pilot would really have chosen changes the game silently. So a
   * pilot promises a continuation only when it is derived from the same plan
   * the next decision would re-derive, the harness drops it the moment the
   * state stops being the one it was planned against (priority moved, a choice
   * was parked, the stack changed, an action was rejected), and the guard is a
   * transcript comparison: whole games with the seam on and off must be
   * identical action for action (`packages/sim/src/action-plan.test.ts`).
   *
   * Omit it (as the searching pilots do) and the harness asks one action at a
   * time, exactly as before.
   */
  chooseActions?(ctx: DecisionContext<TObserver>): readonly GameAction[];
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
