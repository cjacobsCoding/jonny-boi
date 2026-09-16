/**
 * THE FULL-POOL SOAK — thousands of seeded games across the WHOLE shipped pool,
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
 * (`createGameWatcher`): the wrapper sees the settled state before every
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
  defenseOf,
  effectiveKeywords,
  effectiveToughness,
  indexContinuous,
  isAttackable,
  isBattle,
  isCreature,
  isPlaneswalker,
  loyaltyOf,
  NO_MOD,
  PLAYER_IDS,
  PLUS_ONE_COUNTER,
  poolTotal,
  untapsDuringUntapStep,
} from '@jonny-boi/core';
import type { CardPool } from '@jonny-boi/cards';
import type { EffectRegistry } from '@jonny-boi/core';
import type { GameObserver, Observation, Pilot } from '@jonny-boi/ai';
import { loadDeck, type LoadedDeck } from './deck.js';
import { createLandDropCapWatch } from './land-drop-cap.js';
import { DEFAULT_SIM_CONFIG, type SimConfig } from './config.js';
import { runMatch, type MatchResult } from './match.js';
import { gameSeedFor, makeSeats, onPlayFor } from './matchup.js';
import { createObservationLeakScanner } from './observation.js';
import {
  SOAK_EQUIVALENCE_SAMPLE_EVERY,
  SOAK_EVENT_WITNESS,
  SOAK_INVARIANTS,
  SOAK_LEAK_SCAN_SAMPLE_EVERY,
  SOAK_MAX_ACTIONS_PER_GAME,
  SOAK_MAX_STACK_DEPTH,
  SOAK_MAX_TURNS_PER_GAME,
  SOAK_MECHANICS,
  SOAK_RUNAWAY_CHOSEN_EVENT,
  SOAK_RUNAWAY_EVIDENCE_TYPES,
  SOAK_RUNAWAY_FORCED_EVENT,
  SOAK_RUNAWAY_NOISE_EVENTS,
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
  /**
   * Games that ended because ONE TURN ran past `maxActionsPerTurn` and was drawn.
   *
   * ⚠️ Each one is also a {@link SOAK_INVARIANTS.gameCanEnd} violation, and this
   * count is the SUMMARY of them, never the report of them. It used to be
   * "counted, not a violation — a sharp rise here is a finding even though no
   * test fails on it", on the reasoning that only a MANDATORY loop overruns a
   * turn (Dualcaster Mage + Rite of Replication) and the rules legitimately draw
   * those.
   *
   * That reasoning was wrong in the direction that costs the most: nothing
   * watched the count, a pilot that will not stop overruns a turn in exactly the
   * same way, and the per-turn bound is a third of the game-wide cap — so every
   * runaway left through this door and the `gameCanEnd` check never saw one.
   * `loop-runaway.test.ts` measures it: the copy mirror §3.33 fixed ends `loop`
   * at 661 copies and 2,280 actions, against a 6,000-action cap. The deep tier's
   * first sweep with the door watched turned up EIGHT of these, all one card.
   * See DESIGN §3.140.
   */
  readonly loopDraws: number;
  readonly wins: Readonly<Record<PlayerId, number>>;
  readonly violations: readonly SoakViolation[];
  /** How many games each mechanic was witnessed in. */
  readonly mechanicGames: ReadonlyMap<SoakMechanicId, number>;
  /** Mechanics the POOL prints — the ones an occurrence is required for. */
  readonly requiredMechanics: readonly SoakMechanicId[];
  /** Required mechanics that never fired. Non-empty ⇒ an inert feature. */
  readonly inertMechanics: readonly SoakMechanicId[];
  /**
   * How many OBSERVATIONS the redaction scan actually looked at.
   *
   * Reported rather than kept private because "zero leaks" and "zero looks" are
   * the same green, and this run is the only thing standing between a pilot and
   * the opponent's decklist. A caller that asserts no leak must also assert this
   * is large.
   */
  readonly leakScanObservations: number;
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
    case 'suspendCard':
      return `suspendCard#${a.instanceId}`;
    // §3.112
    case 'foretellCard':
      return `foretellCard#${a.instanceId}`;
    case 'plotCard':
      return `plotCard#${a.instanceId}`;
    case 'activateGraveyardAbility': // §3.111
      return `activateGraveyardAbility#${a.instanceId}[${a.abilityIndex}]`;
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
      // §3.112 — which alternative cost is paid is part of WHICH cast this is.
      return `castSpell|${a.player}|${a.instanceId}|${a.fromZone ?? 'hand'}|${a.face ?? 'front'}|${a.alternative ?? 'printed'}`;
    case 'activateAbility':
      return `activateAbility|${a.player}|${a.instanceId}|${a.abilityIndex}`;
    case 'cycleCard':
      return `cycleCard|${a.player}|${a.instanceId}|${a.abilityIndex ?? 0}`;
    case 'suspendCard':
      return `suspendCard|${a.player}|${a.instanceId}`;
    // §3.112
    case 'foretellCard':
      return `foretellCard|${a.player}|${a.instanceId}`;
    case 'plotCard':
      return `plotCard|${a.player}|${a.instanceId}`;
    case 'activateGraveyardAbility': // §3.111
      return `activateGraveyardAbility|${a.player}|${a.instanceId}|${a.abilityIndex}|${(a.targets ?? []).join(',')}|${(a.costInstanceIds ?? []).join(',')}`;
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
export function mechanicOfAction(
  state: GameState,
  action: GameAction,
  defOf: (id: InstanceId) => CardDefinition | undefined,
): SoakMechanicId | undefined {
  switch (action.kind) {
    case 'castSpell':
      // The FACE and the ZONE are the whole point: an ordinary cast, a flashback
      // cast, a madness cast and a split card's second half all emit the same
      // `spellCast` event, and only the action says which happened.
      if (action.face === 'back') return 'second-castable-face';
      // §3.147 — WHICH graveyard keyword paid for this cast is carried by the
      // ACTION, and only by the action: a retrace, a jump-start and an escape
      // emit the same `spellCast` from the same zone as a flashback. Reading the
      // zone alone credited every one of them to `flashback-cast`, which made
      // `graveyard-cast` unreachable — a required mechanic row that no code path
      // could ever tick, reported INERT for a family the engine has had since
      // §3.111. The discriminator was on the action the whole time.
      if (action.fromZone === 'graveyard') {
        return action.graveyardCast === undefined ? 'flashback-cast' : 'graveyard-cast';
      }
      // §3.106 — the free cast out of a SUSPEND window shares the exile zone and
      // the window record with madness; the window's kind says which happened.
      if (action.fromZone === 'exile') return state.madnessWindow?.kind === 'suspend' ? 'suspend' : 'madness';
      return undefined;
    case 'playLand':
      // A modal DFC's LAND half is played, not cast — same second-face system,
      // different action kind.
      return (action as { face?: string }).face === 'back' ? 'second-castable-face' : undefined;
    case 'cycleCard':
      return 'cycling';
    case 'suspendCard':
      return 'suspend';
    // §3.112 — foretell and plot are one mechanic to the soak: "set aside now,
    // cast on a later turn". The cast that follows is an exile-permission cast
    // (`castPermissionFor`), witnessed by the same id through its event.
    case 'foretellCard':
    case 'plotCard':
      return 'cast-later';
    case 'activateGraveyardAbility': // §3.111
      return 'graveyard-ability';
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
function mechanicsOfState(
  state: GameState,
  hits: (id: SoakMechanicId) => void,
  defText: (def: CardDefinition) => string,
): void {
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
    // "As ~ enters, choose a…": the value was named and is REMEMBERED on the
    // instance, which is the whole claim the system makes.
    if ((inst as { chosenAsEntered?: string }).chosenAsEntered !== undefined) hits('as-enters-choice');
    // An intervening "if" is live only while its permanent is on the battlefield
    // to be checked (CR 603.4 checks it on firing AND on resolution).
    if (defText(inst.def).includes('"intervening"')) hits('intervening-if');
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

  /*
   * ⚠️ **STATE-BASED ACTIONS ARE NOT CHECKED MID-RESOLUTION** (CR 704.3: they are
   * checked when a player *would receive priority*, and CR 608.2: a spell
   * finishes resolving first). A spell that deals lethal damage and then parks a
   * question — Magma Jet's "2 damage, then scry 2" — genuinely leaves the dead
   * creature on the battlefield until its scry is answered, and asserting
   * otherwise reports a defect that does not exist. This harness did exactly
   * that on its first run (seed 4100621904, Magma Jet into a Nightwind Glider);
   * the creature dies the instant the choice is answered.
   *
   * `rules-audit.test.ts` documents this discipline ("settled means: between
   * actions, with nothing mid-resolution") without implementing it — its curated
   * decks simply never line the case up. The guard below is the implementation.
   */
  const settled = state.pendingChoice == null && state.resolution == null;
  const cont = indexContinuous(state);
  for (const inst of state.battlefield) {
    if (settled && isCreature(inst.def)) {
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
    // state-based action (CR 704.5i / 704.5s) — so, like the creature checks
    // above, only once the resolution that removed them has finished.
    if (settled && isPlaneswalker(inst.def) && loyaltyOf(inst) <= 0) {
      record(SOAK_INVARIANTS.deadWalkersLeave, `#${inst.instanceId} ${inst.def.name} sits at ${loyaltyOf(inst)} loyalty`);
    }
    if (settled && isBattle(inst.def) && defenseOf(inst) <= 0) {
      record(SOAK_INVARIANTS.deadBattlesLeave, `#${inst.instanceId} ${inst.def.name} sits at ${defenseOf(inst)} defense`);
    }
    for (const [kind, amount] of Object.entries(inst.counters)) {
      // `+1/+1` is the one SIGNED counter in this engine: a -1/-1 counter is
      // modelled as a negative `+1/+1`, because that is the single counter the
      // layer-7d stat pipeline reads (see `persistReturn` in
      // `@jonny-boi/cards` — Kitchen Finks comes back as a 2/1 that way). Every
      // other kind counts UP from zero and a negative one is a bug.
      if (kind !== PLUS_ONE_COUNTER && amount < 0) {
        record(SOAK_INVARIANTS.countersNonNegative, `#${inst.instanceId} ${inst.def.name} has ${amount} ${kind} counters`);
      }
    }
  }

  for (const pid of PLAYER_IDS) {
    const player = state.players[pid as PlayerId];
    if (settled && player.life <= 0 && !state.gameOver) {
      record(SOAK_INVARIANTS.lossAtZeroLife, `${pid} is at ${player.life} life but the game is not over`);
    }
    if (poolTotal(player.manaPool) < 0) {
      record(SOAK_INVARIANTS.manaPoolNonNegative, `${pid}'s mana pool totals ${poolTotal(player.manaPool)}`);
    }
    // THE LAND-DROP CAP is NOT checked here. It cannot be: the count and the cap
    // are read at different moments, and no single state holds both. See
    // `land-drop-cap.ts` — the watcher folds every settled state through one
    // running judgement instead.
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
  /**
   * Every event this game emitted, by type — the EVIDENCE a runaway is ruled on.
   *
   * The mechanic set answers "did this fire at all", which is a different
   * question and deliberately loses the count. A game that overran a turn is
   * only adjudicable if somebody can see WHAT it did 600 times.
   */
  readonly eventCounts: ReadonlyMap<GameEvent['type'], number>;
  /** Turns at which a turn-boundary check ran (so the caller can see it did). */
  readonly turnChecks: number;
  /** The most recent settled state the wrapper was shown, or `null` before any. */
  readonly lastState: GameState | null;
}

function createGameWatcher(inner: Pilot): GameWatcher {
  const violations: { invariant: SoakInvariantName; detail: string; turn: number; step: string; action: string }[] = [];
  const mechanics = new Set<SoakMechanicId>();
  const eventCounts = new Map<GameEvent['type'], number>();
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
  /** Stack object ids seen at the previous decision, and at the previous turn. */
  const stackIdsThisTurn = new Set<InstanceId>();
  let stackIdsLastTurn: ReadonlySet<InstanceId> = new Set();
  /**
   * Permanents that were LEGITIMATELY unable to untap when the previous turn was
   * still running — the same freeze-a-snapshot idiom as `stackIdsLastTurn`, and
   * for the same reason: the fact is gone by the time the check wants it.
   *
   * "Everything the active player controls is untapped at turn start" is FALSE
   * in Magic, and the pool regeneration brought in the cards that prove it. Two
   * printings make it false, and only one is still visible afterwards:
   *
   *  - CONTINUOUS — "~ doesn't untap during your untap step" (Grim Monolith,
   *    Famished Paladin, Lurking Roper, Battered Golem all carry the compiled
   *    `doesNotUntap` flag). Still true at the check, so it could be asked.
   *  - ONE-SHOT — "doesn't untap during its controller's NEXT untap step"
   *    (House Guildmage's first ability, Frost Trickster). This is stored as
   *    `CardInstance.untapSkips` and is SPENT BY THE UNTAP STEP HAPPENING —
   *    `untap.ts` says so explicitly — so by the first decision of the new turn
   *    the counter reads zero and the engine's own predicate answers "it
   *    untaps" about a permanent that correctly did not.
   *
   * Hence the snapshot. Asking `untapsDuringUntapStep` at the check would fix
   * only the first half and would still report Snapcaster Mage and Shoal Kraken
   * — frozen by an opponent's Guildmage — as engine defects.
   */
  let frozenLastTurn: ReadonlySet<InstanceId> = new Set();
  const frozenThisTurn = new Set<InstanceId>();
  let lastTurn = 0;
  let lastState: GameState | null = null;
  let turnChecks = 0;
  /*
   * The land-drop cap is a running judgement, not a snapshot: the count belongs
   * to the turn it was made in and the cap moves when the permanent granting it
   * dies. See `land-drop-cap.ts` — this is the one that spent a 2,000-game soak
   * reporting a legal turn as a violation.
   */
  const landDropCap = createLandDropCapWatch();

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

  /*
   * The same memo keyed by DEFINITION rather than instance, for the state scan:
   * a board holds many instances of one card, and serializing a definition per
   * permanent per decision is the one place this harness could get genuinely
   * slow. Keyed on the definition OBJECT, which the pool shares across copies.
   */
  const serializedDefs = new Map<CardDefinition, string>();
  const defTextOf = (def: CardDefinition): string => {
    let text = serializedDefs.get(def);
    if (text === undefined) {
      text = serializeDefinition(def);
      serializedDefs.set(def, text);
    }
    return text;
  };

  const observeState = (state: GameState, action: string): void => {
    learn(state);
    if (originalIds === null) originalIds = new Set(allInstances(state).map((e) => e.inst.instanceId));
    for (const v of checkStateInvariants(state)) record(v.invariant, v.detail, state, action);
    const landDrops = landDropCap.check(state);
    if (landDrops) record(SOAK_INVARIANTS.landDropCap, landDrops, state, action);
    mechanicsOfState(state, (id) => mechanics.add(id), defTextOf);

    if (state.turnNumber !== lastTurn) {
      lastTurn = state.turnNumber;
      turnChecks++;
      // Freeze what the previous turn ended with before this turn overwrites it.
      stackIdsLastTurn = new Set(stackIdsThisTurn);
      frozenLastTurn = new Set(frozenThisTurn);
      /*
       * Turn-boundary law: what a player checks the instant their turn starts.
       *
       * THE STACK MUST HAVE EMPTIED before the turn ended (CR 500.4 — every step
       * ends with an empty stack, and 514.3's cleanup only repeats while
       * something is waiting). But "the stack is empty at the first decision of
       * the turn" is the WRONG test, and asserting it reported three false
       * defects on this harness's first run: the first decision of a turn is in
       * the UPKEEP, and an upkeep trigger (Delver of Secrets) is put on the stack
       * before anybody gets priority. So what is checked is that no object
       * SURVIVED — the stack objects present now must all be new ones.
       */
      for (const obj of state.stack) {
        if (stackIdsLastTurn.has(obj.instanceId)) {
          record(
            SOAK_INVARIANTS.stackEmpties,
            `stack object #${obj.instanceId} (${obj.kind}) survived from turn ${state.turnNumber - 1} into turn ${state.turnNumber}`,
            state,
            action,
          );
          break;
        }
      }
      const active = state.activePlayer;
      const turnIndex = indexContinuous(state);
      for (const inst of state.battlefield) {
        // Tapped is only a violation when the permanent HAD no reason to stay
        // that way: not frozen while the last turn ran (one-shot, already
        // spent), and not frozen now (continuous, e.g. its own printed flag or
        // an Aura's grant). Asked of the engine's own predicate rather than a
        // list rebuilt here — rule 12, and the list would go stale the day a
        // new printing grants it.
        if (
          inst.controller === active &&
          inst.tapped &&
          !frozenLastTurn.has(inst.instanceId) &&
          untapsDuringUntapStep(state, inst, turnIndex)
        ) {
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
    // Snapshot the stack for the next turn-boundary check above. Cleared and
    // refilled every decision, so it always holds the LAST thing seen on the
    // turn that is ending.
    stackIdsThisTurn.clear();
    for (const obj of state.stack) stackIdsThisTurn.add(obj.instanceId);
    // …and the same for the freeze, for the same reason: this is the last look
    // at the turn that is ending, and `untapSkips` will be spent before the
    // next one is checked.
    frozenThisTurn.clear();
    const frozenIndex = indexContinuous(state);
    for (const inst of state.battlefield) {
      if (!untapsDuringUntapStep(state, inst, frozenIndex)) frozenThisTurn.add(inst.instanceId);
    }
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
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
    const direct = SOAK_EVENT_WITNESS[event.type];
    if (direct) mechanics.add(direct);
    switch (event.type) {
      case 'actionRejected':
        // The soak only ever submits actions that came off the menu, so a
        // rejection means the menu and the apply path disagree about legality —
        // an engine defect, not a pilot one.
        if (lastState) record(SOAK_INVARIANTS.noRejectedActions, `the engine rejected an offered action: ${event.reason}`, lastState, '-');
        break;
      case 'effectUnsupported':
        /*
         * The engine no-ops an effect whose primitive nothing registered and
         * says so. Every card in the shipped pool compiles `'complete'`, so this
         * event in a soak means a pool card is silently playing as LESS than it
         * prints — which is worse than a crash, because the games still finish
         * and the statistics still look fine.
         */
        if (lastState) {
          record(
            SOAK_INVARIANTS.noUnsupportedEffect,
            `"${event.primitive}" is unregistered — a pool card resolved as a no-op`,
            lastState,
            '-',
          );
        }
        break;
      case 'replacementApplied':
        // The generic id is credited by the one-type-one-mechanic table; what
        // the TYPE alone cannot say is WHICH family was replaced, and creating
        // extra OBJECTS is the outcome 'token-count-replacement' had to add —
        // crediting it off any counter doubler would prove nothing about it.
        if (event.event === 'tokens') mechanics.add('token-count-replacement');
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
        // A MANDATORY additional cost is asked as the spell is announced, from
        // the card that prints it — the same source-keyed reading X and kicker
        // use, because the question kind alone cannot tell them apart.
        if (def && (def as { additionalCost?: unknown }).additionalCost !== undefined) {
          mechanics.add('additional-cast-cost');
        }
        // A multi-destination search asks its chooser per destination; the
        // `route` param is what makes it more than a plain tutor.
        if (text.includes('"route"')) mechanics.add('tutor-route');
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
    get eventCounts() {
      return eventCounts;
    },
    get turnChecks() {
      return turnChecks;
    },
    get lastState() {
      return lastState;
    },
  };
}

// ---------------------------------------------------------------------------
// The observation-leak scan, run over randomised full-pool decks.
//
// The SCANNER itself lives in `observation.ts`, beside the policy table it is
// checking — `observation.test.ts` runs the same one over mechanic-anchored
// decks. Two copies of an anti-cheat check is two checks that can disagree, and
// the weaker one is the one that gets believed: the copy that used to live here
// already knew about the buyback case and the "hidden before as well as after"
// rule while the copy in the test file knew neither, and the test file is the
// one whose name says it owns the guarantee.
// ---------------------------------------------------------------------------

/**
 * A pilot that watches the observation feed and reports anything it should not
 * have been told. Wraps the soak pilot so a scanned game plays IDENTICALLY to an
 * unscanned one apart from the observer being attached.
 *
 * See {@link createObservationLeakScanner} for what "should not have been told"
 * means precisely, and for why the flush point is the next decision rather than
 * the moment of delivery.
 */
function createLeakScanningPilot(
  inner: Pilot,
  report: (detail: string) => void,
): Pilot & { flush(state: GameState | null): void; readonly scanned: number } {
  const scanner = createObservationLeakScanner(report);
  return {
    id: `leakscan(${inner.id})`,
    description: `${inner.description} — plus the soak's redaction scan`,
    flush: (state) => scanner.flush(state),
    get scanned() {
      return scanner.scanned;
    },
    chooseAction(ctx) {
      scanner.flush(ctx.view as unknown as GameState);
      return inner.chooseAction(ctx);
    },
    createGameObserver(): GameObserver {
      return {
        observe(observation: Observation) {
          scanner.observe(observation);
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

/**
 * WHO CHOSE — the half of the evidence that actually decides a runaway row.
 *
 * See {@link SOAK_RUNAWAY_CHOSEN_EVENT}. Stated on every row rather than left to
 * {@link describeGameTraffic}'s volume ranking, which would have dropped it off
 * the end of the one row it mattered most on. It reports the split and stops:
 * naming which side wins would be the engine ruling on intent it cannot see.
 */
function describeWhoChose(counts: ReadonlyMap<GameEvent['type'], number>): string {
  const chosen = counts.get(SOAK_RUNAWAY_CHOSEN_EVENT) ?? 0;
  const forced = counts.get(SOAK_RUNAWAY_FORCED_EVENT) ?? 0;
  // ⚠️ SAY "THIS TELLS YOU NOTHING" WHEN IT TELLS YOU NOTHING. A loop can be made
  // of plain ACTIONS rather than questions — all eight Bog Initiate runaways read
  // 0 and 0, because activating a mana ability 667 times asks nobody anything —
  // and printing "0 answered, 0 auto-answered, CR 104.4b is compulsory" next to
  // that would dress an absent measurement up as a verdict.
  if (chosen === 0 && forced === 0) {
    return 'The loop asked nobody anything: it is made of plain actions, so this split cannot rule it.';
  }
  return (
    `Of the game's questions ${chosen} were ANSWERED by a player and ${forced} had a single legal ` +
    `option (auto-answered) — CR 104.4b's draw is compulsory at every step.`
  );
}

/**
 * WHAT THE GAME WAS FULL OF — the evidence a runaway row is ruled on.
 *
 * A `{kind:'loop'}` outcome is inferred from an action counter and says only
 * "this turn overran". The soak therefore cannot name the culprit, and must not
 * pretend to; what it CAN do is hand the reader the traffic and let them rule.
 * The heaviest {@link SOAK_RUNAWAY_EVIDENCE_TYPES} types have named the loop in
 * every runaway found so far, and they are read off the game rather than out of
 * a list, so nothing here has to be kept in step with the event union — except
 * {@link SOAK_RUNAWAY_NOISE_EVENTS}, the bookkeeping that is loudest in EVERY
 * runaway and therefore distinguishes none of them.
 *
 * ⚠️ GAME-WIDE, not turn-wide, and the caller's wording says so. The overrunning
 * turn is `maxActionsPerTurn` of the game's actions by construction — 2,000 of
 * ~2,200 in every row the deep tier has produced — so these counts are dominated
 * by it, but they are not scoped to it and must not be reported as if they were.
 */
function describeGameTraffic(counts: ReadonlyMap<GameEvent['type'], number>): string {
  const top = [...counts.entries()]
    .filter(([type]) => !SOAK_RUNAWAY_NOISE_EVENTS.has(type))
    // Count first, then NAME — a tie broken by insertion order would make the
    // evidence depend on the order the engine happened to emit two equal types.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SOAK_RUNAWAY_EVIDENCE_TYPES);
  return top.length === 0 ? '(nothing but bookkeeping)' : top.map(([type, n]) => `${type} ×${n}`).join(', ');
}

/**
 * BOTH DECKLISTS, verbatim — the identity of one soaked game.
 *
 * One function rather than one per caller because this string is what makes a
 * violation replayable: `playOne` stamps it onto every {@link SoakViolation} and
 * `replaySoakMixedGame` hands it back so a pinned test can assert it replayed the
 * game it meant to. Two renderings that could drift is two answers to "which game
 * was this", and the weaker one is the one a green test would be believing.
 */
function describeMatchup(deckA: SoakDeck, deckB: SoakDeck, nameOf: (id: string) => string): string {
  return `A: ${describeDeck(deckA, nameOf)}\n    B: ${describeDeck(deckB, nameOf)}`;
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
  /** Observations the redaction scan looked at (0 when this game was not sampled). */
  readonly scanned: number;
} {
  const decks = describeMatchup(deckA, deckB, nameOf);
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
    return { result: null, violations: out, mechanics: new Set(), scanned: 0 };
  }

  const watcher = createGameWatcher(options.pilot);
  const leakEvery = options.leakScanEvery ?? 0;
  const scanning = leakEvery > 0 && gameIndex % leakEvery === 0;
  const scanner = scanning
    ? createLeakScanningPilot(watcher.pilot, (detail) => push(SOAK_INVARIANTS.noObservationLeak, detail))
    : null;
  const pilot: Pilot = scanner ?? watcher.pilot;

  const seats = makeSeats(loadedA, loadedB, { pilotA: pilot, pilotB: pilot }, options.registry);

  let result: MatchResult;
  try {
    result = runMatch(seats, seed, { sim, startingPlayer: onPlayFor(gameIndex), onEvent: watcher.onEvent });
  } catch (err) {
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    push(SOAK_INVARIANTS.noException, stack.split('\n').slice(0, 6).join(' | '));
    return { result: null, violations: out, mechanics: watcher.mechanics, scanned: scanner?.scanned ?? 0 };
  }

  // The tail: observations emitted by the game's final action, which no later
  // decision will flush. See `createLeakScanningPilot` for why the state used
  // here is the closest available truth.
  scanner?.flush(watcher.lastState);

  for (const v of watcher.violations) push(v.invariant, v.detail, v.turn, v.step, v.action);

  if (result.actions >= sim.maxActionsPerGame) {
    push(
      SOAK_INVARIANTS.gameCanEnd,
      `the game burned the ${sim.maxActionsPerGame}-action cap without ending (turn ${result.turns})`,
      result.turns,
    );
  }
  // ⚠️ THE OTHER DOOR OUT OF A RUNAWAY, and it is the one every runaway takes.
  //
  // The per-turn bound (2,000) is a THIRD of the game-wide cap (6,000), so a game
  // that cannot end trips it FIRST, is recorded as a CR 104.4b draw, and never
  // reaches the cap the line above watches. The invariant that exists to catch
  // "this game cannot end" was therefore structurally incapable of catching it:
  // `loop-runaway.test.ts` drives the exact copy mirror §3.33 fixed and the game
  // ends `loop` at 661 copies, 2,280 actions — nowhere near the 6,000 the check
  // above wanted. Before this push it reported nothing at all. See DESIGN §3.140.
  //
  // Reported rather than ADJUDICATED, because the engine cannot tell the two
  // apart from here and must not pretend to. CR 104.4b legitimately draws a
  // MANDATORY loop; a pilot re-aiming a copy 661 times is not in one, it simply
  // will not stop. `{kind:'loop'}` is inferred from an action counter and means
  // only "this turn overran" — so the soak states what it saw, hands over the
  // traffic that produced it, and leaves the ruling to whoever reads the row. A
  // loop a human has ruled MANDATORY becomes a pinned row in
  // `loop-runaway.test.ts` that says so and names the cards, exactly like every
  // other soak finding.
  if (result.outcome.kind === 'loop') {
    push(
      SOAK_INVARIANTS.gameCanEnd,
      `one turn ran past the ${sim.maxActionsPerTurn}-action turn bound and the game was drawn ` +
        `(turn ${result.turns}, ${result.actions} actions). The GAME's heaviest traffic — the ` +
        `overrunning turn is most of it: ${describeGameTraffic(watcher.eventCounts)}. ` +
        `${describeWhoChose(watcher.eventCounts)} RULE ON IT: a MANDATORY loop (CR 104.4b) is legal ` +
        `and belongs in loop-runaway.test.ts's table, ruled and naming the cards; a pilot that ` +
        `will not stop is a bug.`,
      result.turns,
    );
  }

  const equivalenceEvery = options.equivalenceEvery ?? 0;
  if (equivalenceEvery > 0 && gameIndex % equivalenceEvery === 0) {
    const detail = compareApplyPaths(seats, seed, sim, onPlayFor(gameIndex));
    if (detail) push(SOAK_INVARIANTS.inPlaceEquivalence, detail, result.turns);
  }

  return { result, violations: out, mechanics: watcher.mechanics, scanned: scanner?.scanned ?? 0 };
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
  // ⚠️ THE LOGS ARE COMPARED FIRST, and the order is the whole usefulness of
  // this function. Reporting "actions differs: 321 vs 311" names a SYMPTOM
  // hundreds of steps after the cause and leaves whoever reads it with nothing
  // to go on; the first differing EVENT names the moment the two paths parted,
  // which is where the retained reference or the missed copy actually is. The
  // summary fields are checked afterwards, for a divergence the logs somehow
  // agreed through.
  const a = cloned.events ?? [];
  const b = inPlace.events ?? [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = JSON.stringify(a[i]);
    const right = JSON.stringify(b[i]);
    if (left !== right) return `event ${i} differs: ${left} vs ${right}`;
  }
  if (a.length !== b.length) {
    // The logs agree as far as the shorter one goes, so the divergence is what
    // came NEXT: name it rather than only the lengths.
    const longer = a.length > b.length ? a : b;
    const which = a.length > b.length ? 'cloning' : 'in-place';
    return (
      `event log lengths differ: ${a.length} vs ${b.length}; ` +
      `first extra event (${which}) is ${JSON.stringify(longer[Math.min(a.length, b.length)])}`
    );
  }
  const da = cloned.decisions ?? [];
  const db = inPlace.decisions ?? [];
  for (let i = 0; i < Math.min(da.length, db.length); i++) {
    const left = JSON.stringify(da[i]);
    const right = JSON.stringify(db[i]);
    if (left !== right) return `decision ${i} differs: ${left} vs ${right}`;
  }
  if (da.length !== db.length) return `decision trace lengths differ: ${da.length} vs ${db.length}`;
  if (JSON.stringify(cloned.outcome) !== JSON.stringify(inPlace.outcome)) {
    return `outcome differs: cloning ${JSON.stringify(cloned.outcome)} vs in-place ${JSON.stringify(inPlace.outcome)}`;
  }
  for (const field of ['turns', 'actions', 'rejectedActions'] as const) {
    if (cloned[field] !== inPlace[field]) return `${field} differs: cloning ${cloned[field]} vs in-place ${inPlace[field]}`;
  }
  if (JSON.stringify(cloned.finalLife) !== JSON.stringify(inPlace.finalLife)) {
    return `final life differs: ${JSON.stringify(cloned.finalLife)} vs ${JSON.stringify(inPlace.finalLife)}`;
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
/** What one replayed soak game broke, and WHICH game it was. */
export interface SoakReplayResult {
  readonly violations: readonly SoakViolation[];
  /** Both decklists, verbatim — the same rendering a {@link SoakViolation} carries. */
  readonly decks: string;
}

/** What {@link replaySoakMixedGame} needs: one seed and the things to play it with. */
export interface SoakReplayOptions {
  readonly pool: CardPool;
  readonly registry: EffectRegistry;
  readonly pilot: Pilot;
  /** The `seed` a {@link SoakViolation} printed. */
  readonly seed: number;
  readonly sim?: SimConfig;
  /**
   * Who was on the play. `runSoak` alternates it by ABSOLUTE game index
   * (`onPlayFor`), so a violation from an even index replays with `'A'` — the
   * default — and one from an odd index with `'B'`.
   */
  readonly onPlay?: PlayerId;
  /**
   * The two decklists to play, INSTEAD of generating them from the seed.
   *
   * A pinned regression is keyed to a GAME, and a game is (decks × seed). The
   * decks half is generated by SAMPLING THE POOL — so the day a card is added,
   * every pinned seed deals a different match and the row's `mustContain` guard
   * fires. That guard is working exactly as designed, but it leaves the
   * regression with nowhere to live: the bug is still fixed, the position simply
   * is not dealt any more, and re-running does not find it. Adding two cards in
   * §3.35 did this to three of the four rows below, and an 8,000-game hunt with
   * the fix reverted did not re-deal the copy mirror even once.
   *
   * Supplying the decks makes a row SELF-DESCRIBING: it replays the exact game
   * the bug came from, for ever, whatever the pool does next. Card ids are
   * Scryfall UUIDs, which are stable across pool churn — only the sampling
   * moved, never the cards.
   *
   * `mustContain` still earns its place: it now proves the pinned DECKLIST is
   * the right one, which is what a copy-paste error between rows would break.
   */
  readonly decks?: { readonly A: SoakDeck; readonly B: SoakDeck };
}

/**
 * Replay ONE mixed-deck soak game from its seed alone, and return what it broke.
 *
 * This file's header promises that a violation is "a bug report you can paste
 * into a new test". Until this existed that was only half true: the seed and both
 * decklists were printed, but the only way to reach the game they describe was to
 * re-run the whole tier and hope your `mixedGames` was large enough to contain it
 * — and the bug that prompted this replayed at mixed index 112, three times past
 * the fast tier's reach. A pinned regression that costs a 2,000-game run is not a
 * regression test anybody keeps.
 *
 * Both decks are a pure function of the seed, exactly as the mixed half of
 * `runSoak` builds them, so this plays the same game that violation came from —
 * in the ~200 ms one game costs rather than the minutes the tier does. See
 * `soak.test.ts` for the pinned list.
 *
 * ⚠️ **The decklists come back with the violations, and a pinned test must assert
 * on them.** A replay that quietly plays the WRONG game reports zero violations,
 * which is the same green as a fixed bug — and this is not hypothetical: mutating
 * one bit of the opponent-deck seed left the pinned regression passing, happily
 * replaying a different match. The decks are a game's identity;
 * {@link SoakReplayResult.decks} is how a test says which game it just played.
 */
export function replaySoakMixedGame(options: SoakReplayOptions): SoakReplayResult {
  const sim = soakSimConfig(options.sim);
  const index = indexPoolForSoak(options.pool.cards);
  const nameOf = (id: string) => options.pool.get(id)?.name ?? id;
  const { seed } = options;
  // Pinned decks win over generated ones — see `SoakReplayOptions.decks` for why
  // a row ever needs to carry its own.
  const deckA = options.decks?.A ?? buildMixedDeck(index, seed);
  const deckB = options.decks?.B ?? buildMixedDeck(index, seed ^ 0x27d4eb2f);
  // `playOne` reads the game index for two things only: which seat is on the play,
  // and whether the two sampled checks land on this game. Parity carries the
  // first; the second is switched off outright above, because a replay is asking
  // one narrow question and the leak scan and the apply-path replay both own
  // dedicated tests (`observation.test.ts`, `match-inplace.test.ts`).
  const gameIndex = (options.onPlay ?? 'A') === 'A' ? 0 : 1;
  const played = playOne(
    {
      pool: options.pool,
      registry: options.registry,
      pilot: options.pilot,
      mixedGames: 0,
      baseSeed: 0,
      leakScanEvery: 0,
      equivalenceEvery: 0,
      ...(options.sim ? { sim: options.sim } : {}),
    },
    deckA,
    deckB,
    seed,
    gameIndex,
    sim,
    nameOf,
  );
  return { violations: played.violations, decks: describeMatchup(deckA, deckB, nameOf) };
}

/**
 * The serialisable knobs one soak slice re-runs under — everything in
 * `SoakOptions` that is DATA rather than a live object, so a worker thread can
 * be handed them over `postMessage` and rebuild identical options against its
 * own pool/registry/pilot (DESIGN §3.53).
 */
export interface SoakSliceSettings {
  readonly mixedGames: number;
  readonly anchorAttempts?: number;
  readonly sim?: SimConfig;
  readonly leakScanEvery?: number;
  readonly equivalenceEvery?: number;
}

/** Rebuild full `SoakOptions` from a live context + slice settings (worker side). */
export function soakOptionsFor(
  context: { readonly pool: CardPool; readonly registry: EffectRegistry; readonly pilot: Pilot },
  settings: SoakSliceSettings,
  baseSeed: number,
): SoakOptions {
  return {
    pool: context.pool,
    registry: context.registry,
    pilot: context.pilot,
    mixedGames: settings.mixedGames,
    baseSeed,
    ...(settings.anchorAttempts !== undefined ? { anchorAttempts: settings.anchorAttempts } : {}),
    ...(settings.sim !== undefined ? { sim: settings.sim } : {}),
    ...(settings.leakScanEvery !== undefined ? { leakScanEvery: settings.leakScanEvery } : {}),
    ...(settings.equivalenceEvery !== undefined ? { equivalenceEvery: settings.equivalenceEvery } : {}),
  };
}

/**
 * One PART of a soak run — the anchored half, or a contiguous range of the
 * mixed half. Every field is an exact count or an ordered list, so parts played
 * on different worker threads concatenate (in canonical order) into precisely
 * the run the single thread would have produced — including
 * {@link SoakReport.mechanicGames}'s insertion order, which decides tie order
 * in the printed report and is why `firedPerGame` is an ORDERED list of lists
 * rather than a pre-summed map.
 */
export interface SoakPartial {
  readonly games: number;
  readonly turns: number;
  readonly actions: number;
  readonly timeouts: number;
  readonly actionCapHits: number;
  readonly loopDraws: number;
  readonly wins: Readonly<Record<PlayerId, number>>;
  readonly violations: readonly SoakViolation[];
  /** Mechanics witnessed per game, in game order (a game's Set, in firing order). */
  readonly firedPerGame: readonly (readonly SoakMechanicId[])[];
  readonly leakScanObservations: number;
}

/** The mutable accumulator behind one {@link SoakPartial}. */
interface SoakPartAccumulator {
  games: number;
  turns: number;
  actions: number;
  timeouts: number;
  actionCapHits: number;
  loopDraws: number;
  readonly wins: Record<PlayerId, number>;
  readonly violations: SoakViolation[];
  readonly firedPerGame: SoakMechanicId[][];
  leakScanObservations: number;
}

function emptySoakPart(): SoakPartAccumulator {
  return {
    games: 0,
    turns: 0,
    actions: 0,
    timeouts: 0,
    actionCapHits: 0,
    loopDraws: 0,
    wins: { A: 0, B: 0 },
    violations: [],
    firedPerGame: [],
    leakScanObservations: 0,
  };
}

/**
 * The sampled checks apply to BOTH halves. The anchored half is where the
 * exotic systems live (a transform deck, a madness deck), so scanning only the
 * mixed half would aim the two most expensive checks away from the cards most
 * likely to break them. The stride runs over the GLOBAL game index, so the
 * anchored games at 0, 31, 62 … are the ones that get scanned.
 */
function withSoakSampling(options: SoakOptions): SoakOptions {
  return {
    ...options,
    leakScanEvery: options.leakScanEvery ?? SOAK_LEAK_SCAN_SAMPLE_EVERY,
    equivalenceEvery: options.equivalenceEvery ?? SOAK_EQUIVALENCE_SAMPLE_EVERY,
  };
}

/** Fold one played game into a part. `tick` reports games played IN THIS PART. */
function accountGame(
  part: SoakPartAccumulator,
  played: { readonly violations: readonly SoakViolation[]; readonly scanned: number; readonly mechanics: ReadonlySet<SoakMechanicId> },
  result: MatchResult | null,
  sim: SimConfig,
  tick: ((gamesInPart: number) => void) | undefined,
): void {
  part.violations.push(...played.violations);
  part.leakScanObservations += played.scanned;
  part.firedPerGame.push([...played.mechanics]);
  part.games++;
  if (!result) return; // a game the invariants aborted still counts, but is not ticked — pre-§3.53 behaviour, exactly
  part.turns += result.turns;
  part.actions += result.actions;
  if (result.outcome.kind === 'win') part.wins[result.outcome.winner]++;
  else part.timeouts++;
  if (result.actions >= sim.maxActionsPerGame) part.actionCapHits++;
  if (result.outcome.kind === 'loop') part.loopDraws++;
  tick?.(part.games);
}

/**
 * THE ANCHORED HALF — one matchup per mechanic the pool prints, retrying up to
 * `anchorAttempts` seeds until the mechanic fires. Inherently SEQUENTIAL: the
 * global game index each game runs at (which decides whether the sampled
 * leak/equivalence checks land on it) depends on how many attempts every
 * earlier mechanic took, so this half is one indivisible part.
 */
/**
 * The mechanic whose ENABLERS belong in the opponent's deck for this anchor,
 * or undefined when the anchor keeps its own. One reader for both anchoring
 * loops, so the grid and the overtime lane cannot disagree about who brings the
 * other half of an interaction.
 */
function opponentEnablersFor(mechanic: SoakMechanicId): SoakMechanicId | undefined {
  return SOAK_MECHANICS.find((entry) => entry.id === mechanic)?.enablerBelongsToOpponent
    ? mechanic
    : undefined;
}

export function runSoakAnchored(
  options: SoakOptions,
  tick?: (gamesInPart: number) => void,
): SoakPartial {
  const sim = soakSimConfig(options.sim);
  const index = indexPoolForSoak(options.pool.cards);
  const nameOf = (id: string) => options.pool.get(id)?.name ?? id;
  const required = requiredMechanicsOf(index);
  const withSampling = withSoakSampling(options);
  const part = emptySoakPart();

  const attempts = options.anchorAttempts ?? 0;
  for (let m = 0; m < required.length && attempts > 0; m++) {
    const mechanic = required[m]!;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const gameIndex = part.games;
      const seed = gameSeedFor(options.baseSeed, m * attempts + attempt);
      const deckA = buildAnchoredDeck(index, mechanic, seed);
      // The opponent is anchored on a DIFFERENT mechanic, rotating, so an
      // anchored game is still a collision test: the point is that walkers meet
      // Equipment meets protection meets flashback in one game.
      const other = required[(m + 1 + attempt) % required.length]!;
      // A mechanic whose witness needs the OTHER seat to bring something puts it
      // there deliberately, rather than hoping the rotation lands on a deck that
      // happens to carry it (see `SoakMechanic.enablerBelongsToOpponent`).
      const deckB =
        buildAnchoredDeck(index, other, seed ^ 0x5bf03635, opponentEnablersFor(mechanic)) ??
        buildMixedDeck(index, seed ^ 0x5bf03635);
      if (!deckA) break; // the pool cannot anchor it — reported by the inert list
      const played = playOne(withSampling, deckA, deckB, seed, gameIndex, sim, nameOf);
      accountGame(part, played, played.result, sim, tick);
      if (played.mechanics.has(mechanic)) break; // it fired — stop spending seeds
    }
  }

  // --- sequenced-witness overtime (additive; own seed lane; §3.56) ----------
  // Runs ONLY for mechanics the grid left unfired that declare extra attempts,
  // with seeds derived off a salted lane — so the grid above keeps byte-for-byte
  // the seeds it always had, and a mechanic opting in cannot re-roll any other
  // mechanic's witness. Inside the ANCHORED slice on purpose: the parallel host
  // treats this half as one indivisible part, so sequential and parallel runs
  // stay byte-identical with the overtime included. See
  // SoakMechanic.extraAnchorAttempts for the two-cast-sequence measurement.
  for (let m = 0; m < required.length && attempts > 0; m++) {
    const mechanic = required[m]!;
    const extra = SOAK_MECHANICS.find((entry) => entry.id === mechanic)?.extraAnchorAttempts ?? 0;
    if (extra <= 0 || part.firedPerGame.some((fired) => fired.includes(mechanic))) continue;
    for (let attempt = 0; attempt < extra; attempt++) {
      const gameIndex = part.games;
      const seed = gameSeedFor(options.baseSeed ^ 0x7a3c9e15, m * extra + attempt);
      const deckA = buildAnchoredDeck(index, mechanic, seed);
      if (!deckA) break;
      const other = required[(m + 1 + attempt) % required.length]!;
      // A mechanic whose witness needs the OTHER seat to bring something puts it
      // there deliberately, rather than hoping the rotation lands on a deck that
      // happens to carry it (see `SoakMechanic.enablerBelongsToOpponent`).
      const deckB =
        buildAnchoredDeck(index, other, seed ^ 0x5bf03635, opponentEnablersFor(mechanic)) ??
        buildMixedDeck(index, seed ^ 0x5bf03635);
      const played = playOne(withSampling, deckA, deckB, seed, gameIndex, sim, nameOf);
      accountGame(part, played, played.result, sim, tick);
      if (played.mechanics.has(mechanic)) break;
    }
  }

  return part;
}

/**
 * MIXED games `[gameStart, gameEnd)` of the run's `mixedGames` — the parallel
 * unit. Each game's seed and decks are pure functions of its ABSOLUTE mixed
 * index `g`, and its global game index is `firstGameIndex + g` (the anchored
 * half's game count — the caller knows it because the anchored half ran first),
 * so a range plays byte-identical games to that stretch of the sequential run,
 * sampled checks included.
 */
export function runSoakMixedRange(
  options: SoakOptions,
  firstGameIndex: number,
  gameStart: number,
  gameEnd: number,
  tick?: (gamesInPart: number) => void,
): SoakPartial {
  const sim = soakSimConfig(options.sim);
  const index = indexPoolForSoak(options.pool.cards);
  const nameOf = (id: string) => options.pool.get(id)?.name ?? id;
  const withSampling = withSoakSampling(options);
  const part = emptySoakPart();

  for (let g = gameStart; g < gameEnd; g++) {
    const gameIndex = firstGameIndex + g;
    const seed = gameSeedFor(options.baseSeed ^ 0x1d872b41, g);
    const deckA = buildMixedDeck(index, seed);
    const deckB = buildMixedDeck(index, seed ^ 0x27d4eb2f);
    const played = playOne(withSampling, deckA, deckB, seed, gameIndex, sim, nameOf);
    accountGame(part, played, played.result, sim, tick);
  }
  return part;
}

/**
 * Reduce parts (in canonical order: anchored first, then mixed ranges by game
 * start) to the one `SoakReport`. Tallies are replayed game by game, in order,
 * so the mechanics map's insertion order — and therefore the printed report —
 * is identical to the single-threaded run's.
 */
export function finishSoak(
  pool: CardPool,
  parts: readonly SoakPartial[],
  cpuMillis: number,
): SoakReport {
  const required = requiredMechanicsOf(indexPoolForSoak(pool.cards));
  const mechanicGames = new Map<SoakMechanicId, number>();
  const wins: Record<PlayerId, number> = { A: 0, B: 0 };
  const violations: SoakViolation[] = [];
  let games = 0;
  let turns = 0;
  let actions = 0;
  let timeouts = 0;
  let actionCapHits = 0;
  let loopDraws = 0;
  let leakScanObservations = 0;

  for (const part of parts) {
    games += part.games;
    turns += part.turns;
    actions += part.actions;
    timeouts += part.timeouts;
    actionCapHits += part.actionCapHits;
    loopDraws += part.loopDraws;
    wins.A += part.wins.A;
    wins.B += part.wins.B;
    violations.push(...part.violations);
    leakScanObservations += part.leakScanObservations;
    for (const fired of part.firedPerGame) {
      for (const id of fired) mechanicGames.set(id, (mechanicGames.get(id) ?? 0) + 1);
    }
  }

  return {
    games,
    turns,
    actions,
    timeouts,
    actionCapHits,
    loopDraws,
    wins,
    violations,
    mechanicGames,
    requiredMechanics: required,
    inertMechanics: required.filter((id) => (mechanicGames.get(id) ?? 0) === 0),
    leakScanObservations,
    cpuMillis,
  };
}

export function runSoak(options: SoakOptions): SoakReport {
  const required = requiredMechanicsOf(indexPoolForSoak(options.pool.cards));
  const total =
    options.mixedGames + (options.anchorAttempts ? required.length * options.anchorAttempts : 0);
  const cpuStart = process.cpuUsage();

  // Anchored, then mixed — the split is the parallel seam (`parallel-slices.ts`
  // runs the same two functions on worker threads); run sequentially here it
  // reproduces the pre-§3.53 loop game for game, which `soak.test.ts` pins.
  const anchored = runSoakAnchored(options, (n) => options.onGame?.(n, total));
  const mixed = runSoakMixedRange(options, anchored.games, 0, options.mixedGames, (n) =>
    options.onGame?.(anchored.games + n, total),
  );

  const cpu = process.cpuUsage(cpuStart);
  return finishSoak(options.pool, [anchored, mixed], (cpu.user + cpu.system) / 1000);
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

/**
 * THE GAMES THAT COULD NOT END — one funnel, both doors.
 *
 * A game runs away through the game-wide action cap OR through the per-turn
 * bound that draws it by CR 104.4b, and for years only the first was watched:
 * `SoakReport.actionCapHits` was the number every tier asserted on, so a runaway
 * that tripped the turn bound first — which is EVERY runaway, the bound being a
 * third of the cap — was counted as a legal loop draw and passed. Asking the
 * question twice in two tiers is how that gap survived a rewrite, so the tiers
 * now ask it here (DESIGN §3.140).
 */
export function runawayGames(report: SoakReport): readonly SoakViolation[] {
  return report.violations.filter((v) => v.invariant === SOAK_INVARIANTS.gameCanEnd);
}

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
  // Said out loud on every run: "no leaks" and "nothing scanned" print the same
  // green otherwise, and this is the anti-cheat guarantee.
  lines.push(`  redaction scan: ${report.leakScanObservations} observation(s) checked`);
  // The two doors out of a runaway, and both are `gameCanEnd` violations listed
  // below. Summarised here as well because a reader scanning the head of a report
  // must not have to count `✗` lines to learn that eight games could not end —
  // and because this line spent its whole life saying a loop draw was legal and
  // merely watched, which is how the invariant stayed switched off (§3.140).
  if (report.actionCapHits > 0) lines.push(`  ⚠ ${report.actionCapHits} game(s) hit the ACTION cap — a game that cannot end`);
  if (report.loopDraws > 0) {
    lines.push(
      `  ↻ ${report.loopDraws} game(s) ended on the TURN bound, not on the board — each is a ` +
        `"${SOAK_INVARIANTS.gameCanEnd}" violation below, with the traffic that produced it. ` +
        `Rule on each: a MANDATORY loop (CR 104.4b) is legal and belongs in loop-runaway.test.ts's ` +
        `ruled table; a pilot that will not stop is a bug.`,
    );
  }
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
