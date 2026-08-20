/**
 * THE FULL-POOL SOAK — thousands of seeded games across the whole 357-card pool,
 * asserting invariants and tallying that every mechanic actually FIRED.
 *
 * `soak-config.ts` holds the constants, the mechanic inventory and the
 * event-classification manifest; `soak-decks.ts` builds the decks. This file is
 * the runner: it plays games through the REAL harness (`runMatch`, in-place
 * apply and all — a soak of a different loop would soak a different program) and
 * hangs three kinds of check off it.
 *
 * ## How the checks attach without forking the harness
 * `runMatch` hands each decision to a `Pilot`. So the soak WRAPS the pilot
 * ({@link createSoakPilot}): the wrapper sees the settled state before every
 * decision — which is precisely the moment state-based actions have finished, so
 * it is the right place to demand that nothing dead is still on the battlefield
 * — and it sees the ACTION the pilot chose, which is where a flashback cast, a
 * cycle, a loyalty activation and a walker being attacked are distinguishable
 * (the events they emit are not: every cast emits `spellCast`). Events are
 * watched through `runMatch`'s existing `onEvent` seam.
 *
 * Nothing here edits `match.ts`, `matchup.ts` or any shipped loop.
 *
 * ## The three checks
 * 1. **Invariants** ({@link SOAK_INVARIANTS}) — asserted on every settled state.
 *    Not "the game finished": the recorded failure in this repo is a check that
 *    reports something other than "I didn't check", and "it finished" is the
 *    canonical example (a combat bug once made games unable to END while the
 *    whole suite stayed green).
 * 2. **Occurrence** — a per-mechanic tally. A soak that never casts a flashback
 *    spell proves nothing about flashback, so the run FAILS when a mechanic the
 *    POOL PRINTS never fires. This is the sim-side twin of
 *    `packages/cards/src/pool-mechanics.test.ts`.
 * 3. **Equivalence** — `applyActionInPlace` replayed against the cloning
 *    `applyAction` on soak decks, extending `match-inplace.test.ts` (which only
 *    covers four curated decks) to the systems that shipped after it.
 *
 * ## Reproducibility
 * Every deck, seat and shuffle is a pure function of {@link SoakOptions.baseSeed}
 * and the game index. A violation carries the seed AND both decklists, so the
 * failure message is a bug report that replays.
 */

import type {
  CardDefinition,
  CardInstance,
  GameAction,
  GameEvent,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  DEFAULT_RULES,
  effectiveKeywords,
  effectiveToughness,
  indexContinuous,
  isAttackable,
  isBattle,
  isCreature,
  isPlaneswalker,
  NO_MOD,
  PLAYER_IDS,
  poolTotal,
} from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { EffectRegistry } from '@jonny-boi/core';
import type { GameObserver, Observation, Pilot } from '@jonny-boi/ai';
import { collectInstanceIds } from '@jonny-boi/protocol';
import { loadDeck, type LoadedDeck } from './deck.js';
import { DEFAULT_SIM_CONFIG, type SimConfig } from './config.js';
import { runMatch, type MatchResult } from './match.js';
import { gameSeedFor, makeSeats, onPlayFor } from './matchup.js';
import { hiddenInstanceIds } from './observation.js';
import {
  SOAK_EQUIVALENCE_SAMPLE_EVERY,
  SOAK_EVENT_WITNESS,
  SOAK_INVARIANTS,
  SOAK_LEAK_SCAN_SAMPLE_EVERY,
  SOAK_MAX_ACTIONS_PER_GAME,
  SOAK_MAX_STACK_DEPTH,
  SOAK_MAX_TURNS_PER_GAME,
  SOAK_MECHANICS,
  serializeDefinition,
  type SoakInvariantName,
  type SoakMechanicId,
} from './soak-config.js';
import {
  buildAnchoredDeck,
  buildMixedDeck,
  describeDeck,
  indexPoolForSoak,
  type SoakCardIndex,
  type SoakDeck,
} from './soak-decks.js';

// ---------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------

/** One invariant break, with everything needed to reproduce it. */
export interface SoakViolation {
  readonly invariant: SoakInvariantName;
  readonly detail: string;
  /** The game seed — `runSoak` replays this exact game from it. */
  readonly seed: number;
  readonly turn: number;
  readonly step: string;
  /** The action being taken when the break was seen (or `'-'` before any). */
  readonly action: string;
  /** Both decklists, verbatim, so the game rebuilds without the run. */
  readonly decks: string;
}

/** The aggregate of a soak run. */
export interface SoakReport {
  readonly games: number;
  readonly turns: number;
  readonly actions: number;
  /** Games that ended on the TURN cap — a stalled board, not necessarily a bug. */
  readonly timeouts: number;
  /**
   * Games that ended on the ACTION cap. Zero on a healthy engine: no legitimate
   * game of 60 turns needs {@link SOAK_MAX_ACTIONS_PER_GAME} actions, so this is
   * the "the game cannot END" signature.
   */
  readonly actionCapHits: number;
  readonly wins: Readonly<Record<PlayerId, number>>;
  readonly violations: readonly SoakViolation[];
  /** How many games each mechanic was witnessed in. */
  readonly mechanicGames: ReadonlyMap<SoakMechanicId, number>;
  /** Mechanics the POOL prints — the ones an occurrence is required for. */
  readonly requiredMechanics: readonly SoakMechanicId[];
  /** Required mechanics that never fired. Non-empty ⇒ an inert feature. */
  readonly inertMechanics: readonly SoakMechanicId[];
  /** CPU milliseconds the run consumed (wall clock is worthless on this box). */
  readonly cpuMillis: number;
}

/** What to play. */
export interface SoakOptions {
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  readonly pilot: Pilot;
  /** Unanchored mixed-deck games. */
  readonly mixedGames: number;
  /**
   * Play one anchored matchup per mechanic the pool prints, retrying up to
   * `attempts` seeds until the mechanic fires. Off (0) for a pure mixed run.
   */
  readonly anchorAttempts?: number;
  readonly baseSeed: number;
  readonly sim?: SimConfig;
  /** Run the observation-leak scan on 1-in-N games (0 = never). */
  readonly leakScanEvery?: number;
  /** Replay 1-in-N games through the cloning apply path (0 = never). */
  readonly equivalenceEvery?: number;
  /** Called after each game, for a progress line in the deep tier. */
  readonly onGame?: (played: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// The per-game watcher.
// ---------------------------------------------------------------------------

/** Every instance the game knows about, with the zone it is actually sitting in. */
function allInstances(state: GameState): { readonly inst: CardInstance; readonly actualZone: string }[] {
  const out: { inst: CardInstance; actualZone: string }[] = [];
  for (const inst of state.battlefield) out.push({ inst, actualZone: 'battlefield' });
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid as PlayerId];
    for (const inst of p.library) out.push({ inst, actualZone: 'library' });
    for (const inst of p.hand) out.push({ inst, actualZone: 'hand' });
    for (const inst of p.graveyard) out.push({ inst, actualZone: 'graveyard' });
    for (const inst of p.exile) out.push({ inst, actualZone: 'exile' });
    for (const inst of p.command) out.push({ inst, actualZone: 'command' });
  }
  for (const obj of state.stack) {
    if (obj.kind === 'spell') out.push({ inst: obj.card, actualZone: 'stack' });
  }
  return out;
}

/** A short, greppable rendering of an action for a failure message. */
export function describeAction(a: GameAction): string {
  switch (a.kind) {
    case 'castSpell':
      return `castSpell#${a.instanceId}${a.fromZone ? `/${a.fromZone}` : ''}${a.face ? `/${a.face}` : ''}`;
    case 'activateAbility':
      return `activateAbility#${a.instanceId}[${a.abilityIndex}]`;
    case 'cycleCard':
      return `cycleCard#${a.instanceId}`;
    case 'playLand':
      return `playLand#${a.instanceId}`;
    case 'tapForMana':
      return `tapForMana#${a.instanceId}`;
    case 'declareAttackers':
      return `declareAttackers[${a.attackers.length}]`;
    case 'declareBlockers':
      return `declareBlockers[${a.blocks.length}]`;
    case 'answerChoice':
      return `answerChoice(${a.answer.kind})`;
    default:
      return a.kind;
  }
}

/**
 * The IDENTITY of an action — everything except the parts a caller is allowed to
 * choose for itself.
 *
 * `generateLegalActions` deliberately does NOT enumerate every attack subset,
 * every block assignment, every choice answer or the targets of an untargeted
 * spell: it offers "attack with all eligible", the empty block, a bounded answer
 * menu, and one bare offer per unrestricted spell, and `applyAction` accepts the
 * narrower things a pilot builds from them (engine.ts says so where it builds the
 * menu). A legality check that demanded exact membership would therefore fail on
 * correct play — so identity is checked here and the CHOSEN parts are checked
 * structurally by {@link checkActionLegality}, with `actionRejected` as the
 * end-to-end backstop.
 */
function actionIdentity(a: GameAction): string {
  switch (a.kind) {
    case 'castSpell':
      return `castSpell|${a.player}|${a.instanceId}|${a.fromZone ?? 'hand'}|${a.face ?? 'front'}`;
    case 'activateAbility':
      return `activateAbility|${a.player}|${a.instanceId}|${a.abilityIndex}`;
    case 'cycleCard':
      return `cycleCard|${a.player}|${a.instanceId}|${a.abilityIndex ?? 0}`;
    case 'playLand':
      return `playLand|${a.player}|${a.instanceId}|${(a as { face?: string }).face ?? 'front'}`;
    case 'tapForMana':
      return `tapForMana|${a.player}|${a.instanceId}|${a.mode ?? 0}`;
    case 'declareAttackers':
      return `declareAttackers|${a.player}`;
    case 'declareBlockers':
      return `declareBlockers|${a.player}`;
    case 'answerChoice':
      return `answerChoice|${a.player}|${a.choiceId}`;
    case 'passPriority':
      return `passPriority|${a.player}`;
  }
}

/** Target lists offered for one identity, as comparable strings (empty ⇒ bare offer). */
function targetKey(targets: ReadonlyArray<InstanceId | PlayerId> | undefined): string {
  return (targets ?? []).join(',');
}

/**
 * Is the action the pilot chose legal, given the menu it was offered?
 *
 * Returns a reason when it is not. See {@link actionIdentity} for why this is
 * structural rather than an equality check.
 */
function checkActionLegality(
  state: GameState,
  legal: readonly GameAction[],
  chosen: GameAction,
): string | undefined {
  const identity = actionIdentity(chosen);
  const matches = legal.filter((a) => actionIdentity(a) === identity);
  if (matches.length === 0) {
    return `${describeAction(chosen)} was never offered (${legal.length} legal actions: ${
      [...new Set(legal.map((a) => a.kind))].join(', ')
    })`;
  }

  switch (chosen.kind) {
    case 'castSpell':
    case 'activateAbility': {
      // A RESTRICTED spell/ability is offered once per legal target, so every
      // offer for this identity carries one. Picking a target outside that set
      // is choosing an illegal target from a menu that enumerated the legal
      // ones — the exact mistake the enumeration exists to make impossible.
      const offeredTargets = matches.map((a) => targetKey((a as { targets?: readonly (InstanceId | PlayerId)[] }).targets));
      if (offeredTargets.every((k) => k !== '')) {
        const key = targetKey(chosen.targets);
        if (!offeredTargets.includes(key)) {
          return `${describeAction(chosen)} targets [${key}] but the legal targets were [${offeredTargets.join('] [')}]`;
        }
      }
      return undefined;
    }
    case 'declareAttackers': {
      // The menu offers "attack with everything eligible"; a subset is legal, a
      // creature outside the eligible set is not.
      const eligible = new Set((matches[0] as { attackers: readonly InstanceId[] }).attackers);
      for (const id of chosen.attackers) {
        if (!eligible.has(id)) return `attacker #${id} is not an eligible attacker`;
      }
      for (const [attacker, target] of Object.entries(chosen.attackTargets ?? {})) {
        if (!chosen.attackers.includes(Number(attacker) as InstanceId)) {
          return `attackTargets names #${attacker}, which is not attacking`;
        }
        if (typeof target === 'number') {
          const perm = state.battlefield.find((c) => c.instanceId === target);
          if (!perm || !isAttackable(perm.def)) return `#${attacker} attacks #${target}, which is not attackable`;
        }
      }
      return undefined;
    }
    case 'declareBlockers': {
      const attacking = new Set(state.combat?.attackers ?? []);
      for (const { blocker, attacker } of chosen.blocks) {
        if (!attacking.has(attacker)) return `#${blocker} blocks #${attacker}, which is not attacking`;
        const perm = state.battlefield.find((c) => c.instanceId === blocker);
        if (!perm) return `blocker #${blocker} is not on the battlefield`;
        if (perm.controller !== chosen.player) return `blocker #${blocker} is not controlled by ${chosen.player}`;
        if (perm.tapped) return `blocker #${blocker} is tapped`;
        if (!isCreature(perm.def)) return `blocker #${blocker} (${perm.def.name}) is not a creature`;
      }
      return undefined;
    }
    case 'answerChoice': {
      const pending = state.pendingChoice;
      if (!pending) return 'answered a choice with none outstanding';
      if (pending.id !== chosen.choiceId) return `answered choice ${chosen.choiceId} while ${pending.id} is outstanding`;
      if (pending.chooser !== chosen.player) return `${chosen.player} answered a choice belonging to ${pending.chooser}`;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Which mechanic (if any) this ACTION proves, given the definitions in play. */
function mechanicOfAction(
  state: GameState,
  action: GameAction,
  defOf: (id: InstanceId) => CardDefinition | undefined,
): SoakMechanicId | undefined {
  switch (action.kind) {
    case 'castSpell':
      // The zone is the whole point: an ordinary cast and a flashback cast emit
      // the same event, and only the action says which happened.
      if (action.fromZone === 'graveyard') return 'flashback-cast';
      if (action.fromZone === 'exile') return 'madness';
      return undefined;
    case 'cycleCard':
      return 'cycling';
    case 'activateAbility': {
      const def = defOf(action.instanceId);
      if (def && isPlaneswalker(def)) return 'planeswalker-loyalty';
      return undefined;
    }
    case 'tapForMana': {
      const def = defOf(action.instanceId);
      // The mana-ability MODEL is the rich form: a tap cost beyond {T}, a rider,
      // an activation restriction or board-derived colours. A plain land taps
      // through the same action and proves nothing about it.
      if (def && ((def as { manaAbilities?: readonly unknown[] }).manaAbilities ?? []).length > 0) {
        return 'mana-ability-extras';
      }
      return undefined;
    }
    case 'declareAttackers': {
      for (const target of Object.values(action.attackTargets ?? {})) {
        if (typeof target !== 'number') continue;
        const perm = state.battlefield.find((c) => c.instanceId === target);
        if (perm && isPlaneswalker(perm.def)) return 'planeswalker-attacked';
        if (perm && isBattle(perm.def)) return 'battle-defense';
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Which mechanics this settled STATE witnesses.
 *
 * The weakest of the three witness kinds, and used only where the engine emits
 * no event and the player takes no action: protection refuses a target with a
 * silent legality answer, ward and indestructible are read during resolution and
 * SBAs, a ★/★ P/T is recomputed rather than logged, and a static is not an
 * effect at all. What this proves is that the rules text was IN FORCE on a real
 * board — which is genuinely less than "something ran into it", and is labelled
 * as such wherever it is reported.
 */
function mechanicsOfState(state: GameState, hits: (id: SoakMechanicId) => void): void {
  if ((state.turnFactsA ?? 0) !== 0 || (state.turnFactsB ?? 0) !== 0) hits('turn-facts');
  if (state.battlefield.length === 0) return;
  const cont = indexContinuous(state);
  for (const inst of state.battlefield) {
    const kw = effectiveKeywords(inst, cont.get(inst.instanceId) ?? NO_MOD);
    if ((kw.protectionFrom ?? []).length > 0) hits('protection');
    if ((kw.ward ?? 0) > 0) hits('ward');
    if (kw.indestructible === true) hits('indestructible');
    if (kw.menace === true || kw.defender === true || kw.cantBlock === true || (kw.minBlockers ?? 0) > 0) {
      hits('blocking-restriction');
    }
    if ((inst.def as { characteristicPT?: unknown }).characteristicPT !== undefined) hits('characteristic-pt');
    if (((inst.def as { statics?: readonly unknown[] }).statics ?? []).length > 0) hits('static-buff');
  }
}

/** Check every invariant that reads a settled state. Returns the breaks found. */
function checkStateInvariants(state: GameState): { invariant: SoakInvariantName; detail: string }[] {
  const found: { invariant: SoakInvariantName; detail: string }[] = [];
  const record = (invariant: SoakInvariantName, detail: string) => found.push({ invariant, detail });
  const instances = allInstances(state);

  const seen = new Map<number, string>();
  for (const { inst, actualZone } of instances) {
    const prior = seen.get(inst.instanceId);
    if (prior !== undefined) {
      record(SOAK_INVARIANTS.uniqueZones, `#${inst.instanceId} (${inst.def.name}) is in both ${prior} and ${actualZone}`);
    }
    seen.set(inst.instanceId, actualZone);
    if (inst.zone !== actualZone) {
      record(
        SOAK_INVARIANTS.zoneFieldAgrees,
        `#${inst.instanceId} (${inst.def.name}) is in ${actualZone} but claims zone="${inst.zone}"`,
      );
    }
  }

  if (state.stack.length > SOAK_MAX_STACK_DEPTH) {
    record(SOAK_INVARIANTS.stackDepth, `the stack is ${state.stack.length} deep on turn ${state.turnNumber}`);
  }

  const cont = indexContinuous(state);
  for (const inst of state.battlefield) {
    if (isCreature(inst.def)) {
      const toughness = effectiveToughness(inst, cont.get(inst.instanceId) ?? NO_MOD);
      const kw = effectiveKeywords(inst, cont.get(inst.instanceId) ?? NO_MOD);
      if (toughness <= 0) {
        record(SOAK_INVARIANTS.deadCreaturesLeave, `#${inst.instanceId} ${inst.def.name} has toughness ${toughness}`);
      } else if (inst.damageMarked >= toughness && kw.indestructible !== true) {
        record(
          SOAK_INVARIANTS.deadCreaturesLeave,
          `#${inst.instanceId} ${inst.def.name} has ${inst.damageMarked} damage vs toughness ${toughness}`,
        );
      }
    }
    // A walker whose last loyalty counter is gone, or a battle whose last
    // defense counter is gone, is put into its owner's graveyard by a
    // state-based action (CR 704.5i / 704.5s). Both are counters, so both are
    // also covered by the non-negative check below — this is the "still here"
    // half, which is the one that would let a player attack a dead walker.
    if (isPlaneswalker(inst.def) && (inst.counters['loyalty'] ?? 0) <= 0) {
      record(SOAK_INVARIANTS.deadWalkersLeave, `#${inst.instanceId} ${inst.def.name} sits at ${inst.counters['loyalty'] ?? 0} loyalty`);
    }
    if (isBattle(inst.def) && (inst.counters['defense'] ?? 0) <= 0) {
      record(SOAK_INVARIANTS.deadBattlesLeave, `#${inst.instanceId} ${inst.def.name} sits at ${inst.counters['defense'] ?? 0} defense`);
    }
    for (const [kind, amount] of Object.entries(inst.counters)) {
      if (amount < 0) {
        record(SOAK_INVARIANTS.countersNonNegative, `#${inst.instanceId} ${inst.def.name} has ${amount} ${kind} counters`);
      }
    }
  }

  for (const pid of PLAYER_IDS) {
    const player = state.players[pid as PlayerId];
    if (player.life <= 0 && !state.gameOver) {
      record(SOAK_INVARIANTS.lossAtZeroLife, `${pid} is at ${player.life} life but the game is not over`);
    }
    if (poolTotal(player.manaPool) < 0) {
      record(SOAK_INVARIANTS.manaPoolNonNegative, `${pid}'s mana pool totals ${poolTotal(player.manaPool)}`);
    }
    if (player.landsPlayedThisTurn > DEFAULT_RULES.maxLandsPerTurn) {
      record(SOAK_INVARIANTS.landDropCap, `${pid} played ${player.landsPlayedThisTurn} lands this turn`);
    }
  }

  // A parked question owns the game: only its chooser may act, and only by
  // answering. If anybody else holds priority the game is unanswerable and can
  // never move again — the "cannot END" shape, one layer down.
  const pending = state.pendingChoice;
  if (pending && state.priorityPlayer !== pending.chooser) {
    record(
      SOAK_INVARIANTS.choiceChannel,
      `${pending.chooser} owes an answer to "${pending.sourceName}" but ${state.priorityPlayer} holds priority`,
    );
  }

  return found;
}

/** The per-game watcher: wraps a pilot and accumulates everything the soak checks. */
interface GameWatcher {
  readonly pilot: Pilot;
  readonly onEvent: (event: GameEvent) => void;
  readonly violations: readonly { invariant: SoakInvariantName; detail: string; turn: number; step: string; action: string }[];
  readonly mechanics: ReadonlySet<SoakMechanicId>;
  /** Turns at which a turn-boundary check ran (so the caller can see it did). */
  readonly turnChecks: number;
}

function createGameWatcher(inner: Pilot): GameWatcher {
  const violations: { invariant: SoakInvariantName; detail: string; turn: number; step: string; action: string }[] = [];
  const mechanics = new Set<SoakMechanicId>();
  const reported = new Set<string>();
  /*
   * instanceId → definition, accumulated from every state the wrapper sees.
   * Events name a `sourceInstanceId` and nothing else, and by the time an event
   * arrives the card may have left the zone it was cast from — so the map is
   * built forward rather than looked up backward. It also survives a card
   * leaving the game entirely, which is what a `choiceAsked` from a spell that
   * has already resolved needs.
   */
  const defs = new Map<InstanceId, CardDefinition>();
  const serialized = new Map<InstanceId, string>();
  let originalIds: Set<InstanceId> | null = null;
  let lastTurn = 0;
  let lastState: GameState | null = null;
  let turnChecks = 0;

  const record = (invariant: SoakInvariantName, detail: string, state: GameState, action: string) => {
    // Once per (invariant, game): one systemic break must not bury the others.
    if (reported.has(invariant)) return;
    reported.add(invariant);
    violations.push({ invariant, detail, turn: state.turnNumber, step: state.step, action });
  };

  const learn = (state: GameState): void => {
    for (const { inst } of allInstances(state)) {
      if (!defs.has(inst.instanceId)) defs.set(inst.instanceId, inst.def);
    }
  };

  const defText = (id: InstanceId): string => {
    let text = serialized.get(id);
    if (text === undefined) {
      const def = defs.get(id);
      text = def ? serializeDefinition(def) : '';
      serialized.set(id, text);
    }
    return text;
  };

  const observeState = (state: GameState, action: string): void => {
    learn(state);
    if (originalIds === null) originalIds = new Set(allInstances(state).map((e) => e.inst.instanceId));
    for (const v of checkStateInvariants(state)) record(v.invariant, v.detail, state, action);
    mechanicsOfState(state, (id) => mechanics.add(id));

    if (state.turnNumber !== lastTurn) {
      lastTurn = state.turnNumber;
      turnChecks++;
      // Turn-boundary law: what a player checks the instant their turn starts.
      // The stack must have emptied before the turn ended (CR 500.4/514.3) —
      // a turn that begins with somebody's spell still on it is the shape of a
      // game that cannot end.
      if (state.stack.length > 0) {
        record(SOAK_INVARIANTS.stackEmpties, `${state.stack.length} object(s) survived into turn ${state.turnNumber}`, state, action);
      }
      const active = state.activePlayer;
      for (const inst of state.battlefield) {
        if (inst.controller === active && inst.tapped) {
          record(SOAK_INVARIANTS.untapAtTurnStart, `#${inst.instanceId} ${inst.def.name} is still tapped on turn ${state.turnNumber}`, state, action);
        }
        if (inst.damageMarked !== 0) {
          record(SOAK_INVARIANTS.damageClears, `#${inst.instanceId} ${inst.def.name} still has ${inst.damageMarked} damage on turn ${state.turnNumber}`, state, action);
        }
      }
      const stale = state.continuous.filter((e) => e.duration === 'endOfTurn');
      if (stale.length > 0) {
        record(SOAK_INVARIANTS.temporaryEffectsExpire, `${stale.length} endOfTurn effect(s) survived into turn ${state.turnNumber}`, state, action);
      }
      const present = new Set(allInstances(state).map((e) => e.inst.instanceId));
      for (const id of originalIds) {
        if (!present.has(id)) {
          record(SOAK_INVARIANTS.cardsNeverVanish, `original instance #${id} is in no zone on turn ${state.turnNumber}`, state, action);
          break;
        }
      }
    }
    lastState = state;
  };

  const pilot: Pilot = {
    id: `soak(${inner.id})`,
    description: `${inner.description} — wrapped by the full-pool soak (invariants + mechanic tally)`,
    chooseAction(ctx) {
      const state = ctx.view as unknown as GameState;
      observeState(state, '-');
      const chosen = inner.chooseAction(ctx);
      const reason = checkActionLegality(state, ctx.legalActions, chosen);
      if (reason) record(SOAK_INVARIANTS.legalActionsOnly, reason, state, describeAction(chosen));
      const mechanic = mechanicOfAction(state, chosen, (id) => defs.get(id));
      if (mechanic) mechanics.add(mechanic);
      return chosen;
    },
  };

  const onEvent = (event: GameEvent): void => {
    const direct = SOAK_EVENT_WITNESS[event.type];
    if (direct) mechanics.add(direct);
    switch (event.type) {
      case 'actionRejected':
        // The soak only ever submits actions that came off the menu, so a
        // rejection means the menu and the apply path disagree about legality —
        // an engine defect, not a pilot one.
        if (lastState) record(SOAK_INVARIANTS.noRejectedActions, `the engine rejected an offered action: ${event.reason}`, lastState, '-');
        break;
      case 'counterAdded':
        // Loyalty and defense have their own events; crediting those kinds here
        // would let a planeswalker entering play satisfy the +1/+1 requirement.
        if (event.kind !== 'loyalty' && event.kind !== 'defense') mechanics.add('counters');
        break;
      case 'choiceAsked': {
        // The question's SOURCE is what says which mechanic asked it: X, kicker
        // and buyback all park a question, and scry and surveil are the same
        // look with different destinations.
        const text = defText(event.sourceInstanceId);
        const def = defs.get(event.sourceInstanceId);
        if (event.choiceKind === 'chooseNumber' && def && (def as { xCost?: unknown }).xCost !== undefined) mechanics.add('x-cost');
        if (event.choiceKind === 'payMana' && def) {
          if ((def as { kicker?: unknown }).kicker !== undefined) mechanics.add('kicker');
          if ((def as { buyback?: unknown }).buyback !== undefined) mechanics.add('buyback');
        }
        if (text.includes('"scry"')) mechanics.add('scry');
        if (text.includes('"surveil"')) mechanics.add('surveil');
        if (text.includes('counterUnlessPaid') || text.includes('unlessPaid') || text.includes('mayEffects')) {
          mechanics.add('optional-payment');
        }
        break;
      }
      case 'effectApplied': {
        const text = defText(event.sourceInstanceId);
        if (text.includes('returnFromGraveyard') || text.includes('persistReturn')) mechanics.add('graveyard-recursion');
        break;
      }
      default:
        break;
    }
  };

  return {
    pilot,
    onEvent,
    get violations() {
      return violations;
    },
    get mechanics() {
      return mechanics;
    },
    get turnChecks() {
      return turnChecks;
    },
  };
}

// ---------------------------------------------------------------------------
// The observation-leak scan (an extension of `observation.test.ts`'s, run over
// randomised full-pool decks rather than three curated matchups).
// ---------------------------------------------------------------------------

/** Field names an observation must never carry, whatever the event. */
const FORBIDDEN_OBSERVATION_KEYS: readonly string[] = ['seed', 'prompt', 'answer', 'summary'];

/**
 * A pilot that watches the observation feed and reports anything it should not
 * have been told. Wraps the soak pilot so a scanned game plays IDENTICALLY to an
 * unscanned one apart from the observer being attached.
 */
function createLeakScanningPilot(
  inner: Pilot,
  hidden: () => ReadonlySet<InstanceId>,
  report: (detail: string) => void,
): Pilot {
  return {
    id: `leakscan(${inner.id})`,
    description: `${inner.description} — plus the soak's redaction scan`,
    chooseAction: (ctx) => inner.chooseAction(ctx),
    createGameObserver(): GameObserver {
      return {
        observe(observation: Observation) {
          for (const key of FORBIDDEN_OBSERVATION_KEYS) {
            if (key in (observation as Record<string, unknown>)) {
              report(`observation ${observation.type} carries a forbidden field "${key}"`);
            }
          }
          const present = collectInstanceIds(observation);
          for (const id of hidden()) {
            if (present.has(id)) report(`observation ${observation.type} names #${id}, which is in a hidden zone`);
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** Load a generated deck, or explain why it will not load. */
function loadSoakDeck(deck: SoakDeck, pool: CardPool): LoadedDeck {
  return loadDeck(deck, pool);
}

/** Play one soaked game and return the violations plus what fired. */
function playOne(
  options: SoakOptions,
  deckA: SoakDeck,
  deckB: SoakDeck,
  seed: number,
  gameIndex: number,
  sim: SimConfig,
  nameOf: (id: string) => string,
): {
  readonly result: MatchResult | null;
  readonly violations: readonly SoakViolation[];
  readonly mechanics: ReadonlySet<SoakMechanicId>;
} {
  const decks = `A: ${describeDeck(deckA, nameOf)}\n    B: ${describeDeck(deckB, nameOf)}`;
  const out: SoakViolation[] = [];
  const push = (invariant: SoakInvariantName, detail: string, turn = 0, step = '-', action = '-') => {
    out.push({ invariant, detail, seed, turn, step, action, decks });
  };

  let loadedA: LoadedDeck;
  let loadedB: LoadedDeck;
  try {
    loadedA = loadSoakDeck(deckA, options.pool);
    loadedB = loadSoakDeck(deckB, options.pool);
  } catch (err) {
    push(SOAK_INVARIANTS.noException, `a generated deck is not legal: ${String(err)}`);
    return { result: null, violations: out, mechanics: new Set() };
  }

  const watcher = createGameWatcher(options.pilot);
  const leakEvery = options.leakScanEvery ?? 0;
  const scanning = leakEvery > 0 && gameIndex % leakEvery === 0;
  // The scan needs the hidden set AT THE MOMENT the observation is delivered.
  // `runMatch` owns the state, so the watcher's most recent view is the closest
  // truth available — and it is the right one: an observation is delivered while
  // applying an action whose starting state is exactly that view.
  let liveHidden: ReadonlySet<InstanceId> = new Set();
  const basePilot = watcher.pilot;
  const trackingPilot: Pilot = {
    ...basePilot,
    chooseAction(ctx) {
      liveHidden = hiddenInstanceIds(ctx.view as unknown as GameState);
      return basePilot.chooseAction(ctx);
    },
  };
  const pilot = scanning
    ? createLeakScanningPilot(trackingPilot, () => liveHidden, (detail) => push(SOAK_INVARIANTS.noObservationLeak, detail))
    : trackingPilot;

  const seats = makeSeats(loadedA, loadedB, { pilotA: pilot, pilotB: pilot }, options.registry);

  let result: MatchResult;
  try {
    result = runMatch(seats, seed, { sim, startingPlayer: onPlayFor(gameIndex), onEvent: watcher.onEvent });
  } catch (err) {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    push(SOAK_INVARIANTS.noException, stack.split('\n').slice(0, 6).join(' | '));
    return { result: null, violations: out, mechanics: watcher.mechanics };
  }

  for (const v of watcher.violations) push(v.invariant, v.detail, v.turn, v.step, v.action);

  if (result.actions >= sim.maxActionsPerGame) {
    push(
      SOAK_INVARIANTS.gameCanEnd,
      `the game burned the ${sim.maxActionsPerGame}-action cap without ending (turn ${result.turns})`,
      result.turns,
    );
  }

  const equivalenceEvery = options.equivalenceEvery ?? 0;
  if (equivalenceEvery > 0 && gameIndex % equivalenceEvery === 0) {
    const detail = compareApplyPaths(seats, seed, sim, onPlayFor(gameIndex));
    if (detail) push(SOAK_INVARIANTS.inPlaceEquivalence, detail, result.turns);
  }

  return { result, violations: out, mechanics: watcher.mechanics };
}

/**
 * Replay one game down BOTH apply paths and report the first difference.
 *
 * `match-inplace.test.ts` proves this for four curated decks and three seeds. The
 * systems that shipped afterwards — transform, modal casting, madness, card
 * grants, emblems — all mutate state in shapes that did not exist then, and an
 * in-place path that aliases one of them would be a silent correctness disaster
 * (every win-rate and every A/B verdict in the product is built on `runMatch`).
 * The full event log and decision trace are compared, because a retained
 * reference into a mutated state shows up there first.
 */
export function compareApplyPaths(
  seats: Parameters<typeof runMatch>[0],
  seed: number,
  sim: SimConfig,
  startingPlayer: PlayerId,
): string | undefined {
  const opts = { startingPlayer, recordTrace: true } as const;
  const cloned = runMatch(seats, seed, { ...opts, sim: { ...sim, applyActionsInPlace: false } });
  const inPlace = runMatch(seats, seed, { ...opts, sim: { ...sim, applyActionsInPlace: true } });
  if (JSON.stringify(cloned.outcome) !== JSON.stringify(inPlace.outcome)) {
    return `outcome differs: cloning ${JSON.stringify(cloned.outcome)} vs in-place ${JSON.stringify(inPlace.outcome)}`;
  }
  for (const field of ['turns', 'actions', 'rejectedActions'] as const) {
    if (cloned[field] !== inPlace[field]) return `${field} differs: cloning ${cloned[field]} vs in-place ${inPlace[field]}`;
  }
  if (JSON.stringify(cloned.finalLife) !== JSON.stringify(inPlace.finalLife)) {
    return `final life differs: ${JSON.stringify(cloned.finalLife)} vs ${JSON.stringify(inPlace.finalLife)}`;
  }
  const a = cloned.events ?? [];
  const b = inPlace.events ?? [];
  if (a.length !== b.length) return `event log lengths differ: ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const left = JSON.stringify(a[i]);
    const right = JSON.stringify(b[i]);
    if (left !== right) return `event ${i} differs: ${left} vs ${right}`;
  }
  const da = cloned.decisions ?? [];
  const db = inPlace.decisions ?? [];
  if (da.length !== db.length) return `decision trace lengths differ: ${da.length} vs ${db.length}`;
  for (let i = 0; i < da.length; i++) {
    const left = JSON.stringify(da[i]);
    const right = JSON.stringify(db[i]);
    if (left !== right) return `decision ${i} differs: ${left} vs ${right}`;
  }
  return undefined;
}

/** The sim config a soaked game runs under (tighter caps — see soak-config.ts). */
export function soakSimConfig(base: SimConfig = DEFAULT_SIM_CONFIG): SimConfig {
  return {
    ...base,
    maxTurnsPerGame: SOAK_MAX_TURNS_PER_GAME,
    maxActionsPerGame: SOAK_MAX_ACTIONS_PER_GAME,
  };
}

/** Which mechanics the POOL prints — the ones an occurrence is required for. */
export function requiredMechanicsOf(index: SoakCardIndex): SoakMechanicId[] {
  return SOAK_MECHANICS.filter((m) => (index.byMechanic.get(m.id) ?? []).length > 0).map((m) => m.id);
}

/**
 * Play a soak run.
 *
 * The anchored half comes first: one matchup per mechanic the pool prints,
 * retrying up to `anchorAttempts` seeds until the mechanic fires. That is what
 * makes an occurrence requirement affordable — a purely random run needs tens of
 * thousands of games before the rarest mechanic appears, while an anchored deck
 * is 12 copies of cards that print it.
 */
export function runSoak(options: SoakOptions): SoakReport {
  const sim = soakSimConfig(options.sim);
  const index = indexPoolForSoak(options.pool.cards);
  const nameOf = (id: string) => options.pool.get(id)?.name ?? id;
  const required = requiredMechanicsOf(index);

  const violations: SoakViolation[] = [];
  const mechanicGames = new Map<SoakMechanicId, number>();
  const wins: Record<PlayerId, number> = { A: 0, B: 0 };
  let games = 0;
  let turns = 0;
  let actions = 0;
  let timeouts = 0;
  let actionCapHits = 0;
  const cpuStart = process.cpuUsage();

  const total =
    options.mixedGames + (options.anchorAttempts ? required.length * options.anchorAttempts : 0);

  const tally = (fired: ReadonlySet<SoakMechanicId>) => {
    for (const id of fired) mechanicGames.set(id, (mechanicGames.get(id) ?? 0) + 1);
  };

  const account = (result: MatchResult | null) => {
    games++;
    if (!result) return;
    turns += result.turns;
    actions += result.actions;
    if (result.outcome.kind === 'win') wins[result.outcome.winner]++;
    else timeouts++;
    if (result.actions >= sim.maxActionsPerGame) actionCapHits++;
    options.onGame?.(games, total);
  };

  // --- the anchored half ------------------------------------------------------
  const attempts = options.anchorAttempts ?? 0;
  for (let m = 0; m < required.length && attempts > 0; m++) {
    const mechanic = required[m]!;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const gameIndex = games;
      const seed = gameSeedFor(options.baseSeed, m * attempts + attempt);
      const deckA = buildAnchoredDeck(index, mechanic, seed);
      // The opponent is anchored on a DIFFERENT mechanic, rotating, so an
      // anchored game is still a collision test: the point is that walkers meet
      // Equipment meets protection meets flashback in one game.
      const other = required[(m + 1 + attempt) % required.length]!;
      const deckB = buildAnchoredDeck(index, other, seed ^ 0x5bf03635) ?? buildMixedDeck(index, seed ^ 0x5bf03635);
      if (!deckA) break; // the pool cannot anchor it — reported by the inert list
      const played = playOne(options, deckA, deckB, seed, gameIndex, sim, nameOf);
      violations.push(...played.violations);
      tally(played.mechanics);
      account(played.result);
      if (played.mechanics.has(mechanic)) break; // it fired — stop spending seeds
    }
  }

  // --- the mixed half ---------------------------------------------------------
  for (let g = 0; g < options.mixedGames; g++) {
    const gameIndex = games;
    const seed = gameSeedFor(options.baseSeed ^ 0x1d872b41, g);
    const deckA = buildMixedDeck(index, seed);
    const deckB = buildMixedDeck(index, seed ^ 0x27d4eb2f);
    const played = playOne(
      { ...options, leakScanEvery: options.leakScanEvery ?? SOAK_LEAK_SCAN_SAMPLE_EVERY, equivalenceEvery: options.equivalenceEvery ?? SOAK_EQUIVALENCE_SAMPLE_EVERY },
      deckA,
      deckB,
      seed,
      gameIndex,
      sim,
      nameOf,
    );
    violations.push(...played.violations);
    tally(played.mechanics);
    account(played.result);
  }

  const cpu = process.cpuUsage(cpuStart);
  return {
    games,
    turns,
    actions,
    timeouts,
    actionCapHits,
    wins,
    violations,
    mechanicGames,
    requiredMechanics: required,
    inertMechanics: required.filter((id) => (mechanicGames.get(id) ?? 0) === 0),
    cpuMillis: (cpu.user + cpu.system) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

/** A violation list, formatted as a bug report you can replay. */
export function formatViolations(violations: readonly SoakViolation[]): string {
  if (violations.length === 0) return '  (none)';
  return violations
    .map(
      (v) =>
        `  ✗ ${v.invariant}\n      ${v.detail}\n      seed ${v.seed}, turn ${v.turn}, ${v.step}, at ${v.action}\n    ${v.decks}`,
    )
    .join('\n');
}

/** The whole run, as a human-readable block for a CLI or a failure message. */
export function formatSoakReport(report: SoakReport): string {
  const lines: string[] = [];
  lines.push(
    `games ${report.games} · turns ${report.turns} · actions ${report.actions} · ` +
      `A ${report.wins.A} / B ${report.wins.B} / ${report.timeouts} timeout · ` +
      `${report.cpuMillis.toFixed(0)} ms CPU`,
  );
  if (report.actionCapHits > 0) lines.push(`  ⚠ ${report.actionCapHits} game(s) hit the ACTION cap — a game that cannot end`);
  const fired = [...report.mechanicGames.entries()].sort((a, b) => b[1] - a[1]);
  lines.push('  mechanics witnessed (games):');
  for (const [id, count] of fired) {
    const kind = SOAK_MECHANICS.find((m) => m.id === id)?.witnessKind ?? 'event';
    lines.push(`    ${count.toString().padStart(5)}  ${id}${kind === 'state' ? '  (state witness — see soak-config.ts)' : ''}`);
  }
  const notRequired = SOAK_MECHANICS.filter((m) => !report.requiredMechanics.includes(m.id)).map((m) => m.id);
  if (notRequired.length > 0) lines.push(`  not in the pool (not required): ${notRequired.join(', ')}`);
  if (report.inertMechanics.length > 0) {
    lines.push(`  ✗ INERT — printed in the pool and never fired: ${report.inertMechanics.join(', ')}`);
  }
  lines.push(`  violations: ${report.violations.length}`);
  if (report.violations.length > 0) lines.push(formatViolations(report.violations));
  return lines.join('\n');
}
