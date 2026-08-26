/**
 * ZONE-LEAVE INVARIANTS — the §3.49 invariant for the §3.44 class.
 *
 * §3.44 found three rules that were enforced purely by an instance id ceasing
 * to be on the battlefield — removal from combat (CR 506.4), the attachment
 * SBAs (CR 704.5m/n), and floating continuous effects (CR 400.7) — and one
 * effect (blink) that puts the id straight back before any of them can look.
 * Each got a regression test naming Cloudshift. This file states the RULES as
 * state invariants and drives them through EVERY leave funnel the pool can
 * express, so the next funnel that leaks (a reanimation, a new flicker, a
 * bounce-and-return) fails here without this file ever learning its name.
 *
 * THE INVARIANTS — after any action whose events say instance X left the
 * battlefield (`zoneChange from: 'battlefield'`):
 *
 *  I1 (CR 506.4)   if X is on the battlefield again after the action (a
 *                  same-id return), X is no longer attacking or blocking —
 *                  it must be absent from `attackingCreatureIds` and either
 *                  out of `blocks` or overlaid in `removedFromCombat`.
 *                  (An id that did NOT return is handled by the damage step's
 *                  own liveness gate — that is the engine's documented shape:
 *                  the declaration is never rewritten.)
 *  I2 (CR 704.5m/n) no permanent that was attached to X before the leave is
 *                  still attached to X afterwards.
 *  I3 (CR 400.7)   no continuous effect that targeted X before the leave
 *                  still targets X afterwards — a pump, a keyword grant, or a
 *                  "gain control until end of turn" (the stolen-creature case)
 *                  must not follow the id back.
 *
 * I2/I3 are settled by state-based actions, which run when a player would get
 * priority — so they are asserted at the first post-action state with no
 * choice parked, and carried forward until then.
 *
 * THE FUNNELS are discovered from DATA, not listed: every castable pool card
 * is cast by seat A at a rigged board (an aura'd, equipped, pumped creature of
 * A's; an aura'd, pumped creature of B's; a STOLEN creature under a
 * gain-control-until-end-of-turn), first at sorcery speed and then — instants
 * only — inside combat with the rigged creature attacking and an enchanted
 * blocker in front of it. Whatever a card does — destroy, exile, bounce,
 * blink, fight, damage, sacrifice, mass removal — if its resolution makes any
 * permanent leave the battlefield, the invariants are checked for that id.
 * Combat damage itself (the blocker dying in the damage step) is swept by
 * letting the rigged combat resolve.
 *
 * Every action applied here is one the engine OFFERED (`generateLegalActions`
 * → pick → apply), so the sweep doubles as an offer/apply agreement check
 * over a few hundred real casts: any `actionRejected` fails the run.
 */
import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  GameAction,
  GameEvent,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  attackingCreatureIds,
  cloneState,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  generateLegalActions,
  isRemovedFromCombat,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';

type Registry = ReturnType<typeof buildRegistry>;

// --- pool queries (by CHARACTERISTIC, never by name — the sweep must survive pool edits) ---

function firstPoolCard(label: string, predicate: (card: CardDefinition) => boolean): CardDefinition {
  const found = CARD_POOL.find(predicate);
  if (!found) throw new Error(`the pool no longer holds ${label} — re-pick the rig pieces`);
  return found;
}

const A_LAND = firstPoolCard(
  'a plain land',
  (c) => c.types.includes('land') && c.types.length === 1 && (c.effects?.length ?? 0) === 0,
);
/** A plain creature with no script of its own, so every observed effect belongs to the candidate. */
const plainCreature = (c: CardDefinition): boolean =>
  c.types.includes('creature') &&
  c.types.length === 1 &&
  (c.effects?.length ?? 0) === 0 &&
  (c.triggers?.length ?? 0) === 0 &&
  (c.activated?.length ?? 0) === 0 &&
  c.keywords === undefined &&
  c.characteristicPT === undefined;
const RIG_CREATURE = firstPoolCard('a plain creature', (c) => plainCreature(c) && (c.power ?? 0) >= 2);
const RIG_BLOCKER = firstPoolCard('a small plain creature', (c) => plainCreature(c) && (c.toughness ?? 0) <= 2);
const RIG_AURA = firstPoolCard('an aura', (c) => (c.subtypes ?? []).some((s) => s.toLowerCase() === 'aura'));
const RIG_EQUIPMENT = firstPoolCard('an equipment', (c) =>
  (c.subtypes ?? []).some((s) => s.toLowerCase() === 'equipment'),
);

// --- state building (the fidelity-suite idiom: place, don't cast, so effects are attributable) ---

function placePermanent(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  attachedTo: InstanceId | null = null,
): InstanceId {
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo,
    counters: {},
  });
  return id;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const id = state.nextInstanceId++;
  state.players[player].hand.push({
    instanceId: id,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  });
  return id;
}

function refillMana(state: GameState): void {
  state.players.A.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
  state.players.B.manaPool = { W: 20, U: 20, B: 20, R: 20, G: 20, C: 20 };
}

/** An until-end-of-turn pump, exactly as `pumpUntilEndOfTurn` records one. */
function pumpEntry(state: GameState, target: InstanceId, source: InstanceId): void {
  state.continuous.push({
    id: state.nextInstanceId++,
    targetInstanceId: target,
    sourceInstanceId: source,
    duration: 'endOfTurn',
    power: 2,
    toughness: 2,
  });
}

/** A gain-control-until-end-of-turn, exactly as `applyControlChange` records one. */
function stealUntilEndOfTurn(state: GameState, target: InstanceId, thief: PlayerId, from: PlayerId): void {
  const permanent = state.battlefield.find((c) => c.instanceId === target);
  if (!permanent) throw new Error('steal target missing');
  permanent.controller = thief;
  state.continuous.push({
    id: state.nextInstanceId++,
    targetInstanceId: target,
    sourceInstanceId: target,
    duration: 'endOfTurn',
    controlChange: { instanceId: target, from, to: thief },
  });
}

// --- the invariant checker ----------------------------------------------------------

interface RigIds {
  /** Ids the target-picker prefers, in order. */
  readonly preferred: readonly InstanceId[];
}

/** A departure whose I2/I3 checks are waiting for the next choice-free state. */
interface PendingDeparture {
  readonly id: InstanceId;
  readonly candidate: string;
  /** Continuous-entry ids that targeted `id` before the leave. */
  readonly priorEntryIds: ReadonlySet<number>;
  /** Instance ids that were attached to `id` before the leave. */
  readonly priorAttachers: ReadonlySet<InstanceId>;
}

class InvariantLog {
  readonly violations: string[] = [];
  /** How many battlefield departures this scenario has witnessed (reporting). */
  departures = 0;
  private pending: PendingDeparture[] = [];

  /** Call around every applyAction: `pre` is the state the action was applied to. */
  observe(candidate: string, pre: GameState, post: GameState, events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.type === 'actionRejected') {
        this.violations.push(`${candidate}: engine rejected an action it offered — ${event.reason}`);
      }
      if (event.type !== 'zoneChange' || event.from !== 'battlefield') continue;
      this.departures += 1;
      const id = event.instanceId;
      // I1 is written synchronously by the rule itself, so it is checked NOW.
      const returned = post.battlefield.some((c) => c.instanceId === id);
      if (returned && post.combat) {
        if (attackingCreatureIds(post.combat).includes(id)) {
          this.violations.push(
            `${candidate}: I1 (CR 506.4) — instance ${id} left the battlefield and came back, but is still attacking`,
          );
        }
        if (post.combat.blocks[id] !== undefined && !isRemovedFromCombat(post.combat, id)) {
          this.violations.push(
            `${candidate}: I1 (CR 506.4) — instance ${id} left the battlefield and came back, but is still blocking`,
          );
        }
      }
      // I2/I3 are settled by state-based actions: queue them against the
      // pre-leave snapshot, to be judged at the next choice-free state.
      this.pending.push({
        id,
        candidate,
        priorEntryIds: new Set(pre.continuous.filter((e) => e.targetInstanceId === id).map((e) => e.id)),
        priorAttachers: new Set(
          pre.battlefield.filter((c) => c.attachedTo === id).map((c) => c.instanceId),
        ),
      });
    }
    if (post.pendingChoice == null && this.pending.length > 0) {
      for (const departure of this.pending) this.judge(departure, post);
      this.pending = [];
    }
  }

  private judge(departure: PendingDeparture, state: GameState): void {
    const { id, candidate, priorEntryIds, priorAttachers } = departure;
    for (const permanent of state.battlefield) {
      if (permanent.attachedTo === id && priorAttachers.has(permanent.instanceId)) {
        this.violations.push(
          `${candidate}: I2 (CR 704.5m/n) — ${permanent.def.name} is still attached to instance ${id}, which left the battlefield`,
        );
      }
    }
    for (const entry of state.continuous) {
      if (entry.targetInstanceId === id && priorEntryIds.has(entry.id)) {
        const kind = entry.controlChange ? 'a gain-control effect' : 'a continuous effect';
        this.violations.push(
          `${candidate}: I3 (CR 400.7) — ${kind} from before the leave still targets instance ${id}`,
        );
      }
    }
  }

  /** End-of-scenario: judge anything still parked (a scenario should not end mid-choice). */
  flush(state: GameState): void {
    for (const departure of this.pending) this.judge(departure, state);
    this.pending = [];
  }
}

// --- driving the engine through OFFERED actions only ---------------------------------

/** Apply one offered action, feeding the invariant log. */
function applyOffered(
  state: GameState,
  action: GameAction,
  reg: Registry,
  log: InvariantLog,
  candidate: string,
): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  log.observe(candidate, state, result.state, result.events);
  return result.state;
}

/**
 * Pick this seat's answer from the OFFERED answer menu: say yes, choose the
 * biggest number, and aim at the rig's preferred ids — so an optional effect
 * actually happens and a targetable one actually points at the instrumented
 * creatures. Falls back to the engine's own default answer when the menu
 * offers nothing (the safe decline).
 */
function pickAnswer(offers: readonly GameAction[], rig: RigIds): GameAction | undefined {
  const answers = offers.filter(
    (a): a is Extract<GameAction, { kind: 'answerChoice' }> => a.kind === 'answerChoice',
  );
  if (answers.length === 0) return undefined;
  const byPayload = (want: (payload: string) => boolean) =>
    answers.find((a) => want(JSON.stringify(a.answer)));
  for (const preferredId of rig.preferred) {
    const aimed = byPayload((p) => p.includes(String(preferredId)));
    if (aimed) return aimed;
  }
  const yes = byPayload((p) => p.includes('"yes":true'));
  if (yes) return yes;
  const numbers = answers.filter((a) => (a.answer as { kind?: string }).kind === 'chooseNumber');
  if (numbers.length > 0) {
    return numbers.reduce((best, next) =>
      ((next.answer as { value: number }).value ?? 0) > ((best.answer as { value: number }).value ?? 0) ? next : best,
    );
  }
  return answers[0];
}

/** Settle the stack and every parked question, always through offered actions. */
function settle(state: GameState, reg: Registry, log: InvariantLog, candidate: string, rig: RigIds): GameState {
  let s = state;
  let guard = 0;
  while ((s.stack.length > 0 || s.pendingChoice != null) && !s.gameOver && guard++ < 80) {
    if (s.pendingChoice) {
      const question = s.pendingChoice;
      const offers = generateLegalActions(s, DEFAULT_RULES);
      const answer =
        pickAnswer(offers, rig) ??
        ({
          kind: 'answerChoice',
          player: question.chooser,
          choiceId: question.id,
          answer: defaultAnswerFor(question),
        } as GameAction);
      s = applyOffered(s, answer, reg, log, candidate);
      continue;
    }
    s = applyOffered(s, { kind: 'passPriority', player: s.priorityPlayer }, reg, log, candidate);
  }
  return s;
}

/**
 * Walk the empty pre-rig game to a step of A's turn. Unlike {@link settle},
 * any question asked on the way is answered with the engine's own DEFAULT (the
 * safe decline) — the walk must set the table, not play eagerly.
 */
function walkTo(state: GameState, reg: Registry, log: InvariantLog, step: GameState['step']): GameState {
  let s = state;
  let guard = 0;
  while (!(s.step === step && s.activePlayer === 'A') && !s.gameOver) {
    if (guard++ > 400) throw new Error(`never reached ${step}`);
    const question = s.pendingChoice;
    const action: GameAction = question
      ? { kind: 'answerChoice', player: question.chooser, choiceId: question.id, answer: defaultAnswerFor(question) }
      : { kind: 'passPriority', player: s.priorityPlayer };
    s = applyOffered(s, action, reg, log, 'rig');
  }
  return s;
}

// --- the two rigged boards ------------------------------------------------------------

interface Rig {
  readonly state: GameState;
  readonly ids: RigIds;
}

/**
 * Seat A at their own precombat main. On the battlefield:
 *   X — A's creature: enchanted, equipped, pumped until end of turn;
 *   W — B's creature: enchanted and pumped (for candidates that only aim at
 *       an opponent's board);
 *   Y — B's creature, STOLEN by A until end of turn (the §3.44 theft case).
 */
function buildMainRig(reg: Registry, seed: number): Rig {
  const { state } = createGame({
    seed,
    decks: {
      A: { cards: Array.from({ length: 60 }, () => A_LAND) },
      B: { cards: Array.from({ length: 60 }, () => A_LAND) },
    },
    registry: reg,
  });
  const log = new InvariantLog(); // rig-building violations would be a broken rig
  const s = walkTo(state, reg, log, 'precombatMain');
  if (log.violations.length > 0) throw new Error(`rig walk broke invariants: ${log.violations[0]}`);
  const x = placePermanent(s, RIG_CREATURE, 'A');
  placePermanent(s, RIG_AURA, 'A', x);
  placePermanent(s, RIG_EQUIPMENT, 'A', x);
  pumpEntry(s, x, x);
  const w = placePermanent(s, RIG_CREATURE, 'B');
  placePermanent(s, RIG_AURA, 'B', w);
  pumpEntry(s, w, w);
  const y = placePermanent(s, RIG_BLOCKER, 'B');
  stealUntilEndOfTurn(s, y, 'A', 'B');
  refillMana(s);
  return { state: s, ids: { preferred: [x, w, y] } };
}

/**
 * The same board INSIDE combat: X (enchanted, equipped, pumped) is attacking,
 * B's enchanted, pumped blocker V is in front of it, blocks declared, priority
 * with A — the §3.44 window, held open for every instant in the pool.
 */
function buildCombatRig(reg: Registry, seed: number): Rig {
  const main = buildMainRig(reg, seed);
  const s = main.state;
  const log = new InvariantLog();
  const [x] = main.ids.preferred;
  const v = placePermanent(s, RIG_BLOCKER, 'B');
  placePermanent(s, RIG_AURA, 'B', v);
  pumpEntry(s, v, v);
  let state = walkTo(s, reg, log, 'declareAttackers');
  state = applyOffered(state, { kind: 'declareAttackers', player: 'A', attackers: [x!] }, reg, log, 'rig');
  let guard = 0;
  while (state.step !== 'declareBlockers' && !state.gameOver && guard++ < 30) {
    state = applyOffered(state, { kind: 'passPriority', player: state.priorityPlayer }, reg, log, 'rig');
  }
  state = applyOffered(state, { kind: 'declareBlockers', player: 'B', blocks: [{ blocker: v, attacker: x! }] }, reg, log, 'rig');
  guard = 0;
  while (state.priorityPlayer !== 'A' && !state.gameOver && guard++ < 10) {
    state = applyOffered(state, { kind: 'passPriority', player: state.priorityPlayer }, reg, log, 'rig');
  }
  if (log.violations.length > 0) throw new Error(`combat rig broke invariants: ${log.violations[0]}`);
  refillMana(state);
  return { state, ids: { preferred: [x!, v, ...main.ids.preferred.slice(1)] } };
}

// --- the sweeps -------------------------------------------------------------------------

interface SweepOutcome {
  cast: number;
  skipped: number;
  /** Candidate names that made at least one permanent leave the battlefield. */
  leaveCandidates: Set<string>;
  violations: string[];
}

/**
 * Cast `candidate` from A's hand at the rigged board — through the engine's
 * own offer menu — and settle it, checking the leave invariants after every
 * action. `preferred` orders which offered target to take.
 */
function castAndSettle(
  rig: Rig,
  candidate: CardDefinition,
  reg: Registry,
  preferred: readonly InstanceId[],
  outcome: SweepOutcome,
): void {
  const s = cloneState(rig.state);
  const inHand = giveHand(s, 'A', candidate);
  refillMana(s);
  const offers = generateLegalActions(s, DEFAULT_RULES).filter(
    (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.instanceId === inHand,
  );
  if (offers.length === 0) {
    outcome.skipped += 1;
    return;
  }
  let chosen = offers[0]!;
  for (const want of preferred) {
    const aimed = offers.find((offer) => (offer.targets ?? []).includes(want));
    if (aimed) {
      chosen = aimed;
      break;
    }
  }
  const log = new InvariantLog();
  const rigIds: RigIds = { preferred };
  let state = applyOffered(s, chosen, reg, log, candidate.name);
  state = settle(state, reg, log, candidate.name, rigIds);
  log.flush(state);
  outcome.cast += 1;
  if (log.departures > 0) outcome.leaveCandidates.add(candidate.name);
  outcome.violations.push(...log.violations);
}

function runSweep(rig: Rig, candidates: readonly CardDefinition[], reg: Registry): SweepOutcome {
  const outcome: SweepOutcome = { cast: 0, skipped: 0, leaveCandidates: new Set(), violations: [] };
  const [x, second, ...rest] = rig.ids.preferred;
  for (const candidate of candidates) {
    castAndSettle(rig, candidate, reg, rig.ids.preferred, outcome);
    // A second pass preferring the STOLEN creature (last in the preference
    // list), so "leave while under a temporary control effect" is exercised
    // by every candidate that can aim there — the §3.44 theft direction.
    const stolen = rest[rest.length - 1] ?? second;
    if (stolen !== undefined) {
      castAndSettle(rig, candidate, reg, [stolen, x!, second!], outcome);
    }
  }
  return outcome;
}

/** Every card seat A could conceivably cast proactively. */
const CASTABLE = CARD_POOL.filter((c) => !c.types.includes('land'));
const INSTANTS = CASTABLE.filter((c) => c.types.includes('instant'));

// Floors, so a sweep that silently stops casting (an offer regression, a rig
// break) fails loudly instead of passing vacuously. Measured on `main` at
// §3.49 time: main sweep cast 906 with 45 leave-causing candidates; combat
// sweep cast 150 with 25. The floors sit far enough below those to survive
// ordinary pool drift and close enough to catch a collapse.
const MAIN_SWEEP_MIN_CAST = 300;
const MAIN_SWEEP_MIN_LEAVERS = 30;
const COMBAT_SWEEP_MIN_CAST = 60;
const COMBAT_SWEEP_MIN_LEAVERS = 12;

describe('zone-leave invariants, swept over every pool-drawn funnel (§3.44 class)', () => {
  it('sorcery speed: every castable card, aimed at the rigged board', () => {
    const reg = buildRegistry();
    const rig = buildMainRig(reg, 4931);
    const outcome = runSweep(rig, CASTABLE, reg);
    expect(outcome.violations, outcome.violations.slice(0, 12).join('\n')).toEqual([]);
    expect(outcome.cast, 'the sweep stopped casting — a vacuous pass, not a green one').toBeGreaterThanOrEqual(
      MAIN_SWEEP_MIN_CAST,
    );
    expect(
      outcome.leaveCandidates.size,
      'almost nothing made a permanent leave — the funnels were not exercised',
    ).toBeGreaterThanOrEqual(MAIN_SWEEP_MIN_LEAVERS);
  });

  it('instant speed, inside combat: every instant, with the rigged creature attacking', () => {
    const reg = buildRegistry();
    const rig = buildCombatRig(reg, 4932);
    const outcome = runSweep(rig, INSTANTS, reg);
    expect(outcome.violations, outcome.violations.slice(0, 12).join('\n')).toEqual([]);
    expect(outcome.cast, 'the combat sweep stopped casting').toBeGreaterThanOrEqual(COMBAT_SWEEP_MIN_CAST);
    expect(outcome.leaveCandidates.size, 'no instant removed anything mid-combat').toBeGreaterThanOrEqual(
      COMBAT_SWEEP_MIN_LEAVERS,
    );
  });

  it('combat damage itself: the enchanted, pumped blocker dies in the damage step', () => {
    const reg = buildRegistry();
    const rig = buildCombatRig(reg, 4933);
    const log = new InvariantLog();
    let s = rig.state;
    let guard = 0;
    while (s.step !== 'postcombatMain' && !s.gameOver && guard++ < 60) {
      if (s.pendingChoice) {
        s = settle(s, reg, log, 'combat damage', rig.ids);
        continue;
      }
      s = applyOffered(s, { kind: 'passPriority', player: s.priorityPlayer }, reg, log, 'combat damage');
    }
    log.flush(s);
    expect(log.violations, log.violations.join('\n')).toEqual([]);
    // The funnel really ran: someone died in that combat.
    expect(s.battlefield.length, 'nothing died — the combat-damage funnel was not exercised').toBeLessThan(
      rig.state.battlefield.length,
    );
  });
});
