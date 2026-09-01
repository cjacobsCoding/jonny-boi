/**
 * RULES AUDIT — plays real games with the real card pool and asserts basic MTG
 * law after EVERY action.
 *
 * The unit tests elsewhere check systems in isolation against hand-built states.
 * This is the opposite: no fixtures, no sculpted positions — just full games,
 * every seed, checking the invariants a player would notice instantly if they
 * broke ("my creature didn't untap", "a card vanished", "that thing should be
 * dead"). Isolated tests keep passing while the assembled game misbehaves; this
 * is the net for that.
 *
 * Each invariant names the player-visible symptom it guards, so a failure reads
 * as a bug report rather than an assertion number.
 */

import { describe, expect, it } from 'vitest';
import { createDefaultAiRegistry, HEURISTIC_PILOT_ID } from '@jonny-boi/ai';
import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  effectiveToughness,
  generateLegalActions,
  indexContinuous,
  isCreature,
  NO_MOD,
  PLAYER_IDS,
  poolTotal,
  type CardInstance,
  type GameAction,
  type GameState,
  type PlayerId,
  maxLandPlaysFor,
} from '@jonny-boi/core';
import { SAMPLE_DECKS } from '../data/decks/index.js';
import { loadDeck } from './deck.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const ai = createDefaultAiRegistry();

/** How many seeded games each audit plays. Enough to cross many board states. */
const AUDIT_GAMES = 12;
/** Hard cap on actions per game so a stall fails loudly instead of hanging. */
const MAX_ACTIONS = 4000;

/** A violation: which invariant broke, and enough context to act on it. */
interface Violation {
  readonly invariant: string;
  readonly detail: string;
  readonly seed: number;
  readonly turn: number;
  readonly step: string;
  readonly action: string;
}

function describeAction(a: GameAction): string {
  switch (a.kind) {
    case 'tapForMana':
      return `tapForMana#${a.instanceId}`;
    case 'castSpell':
      return `castSpell#${a.instanceId}`;
    case 'playLand':
      return `playLand#${a.instanceId}`;
    case 'declareAttackers':
      return `declareAttackers[${a.attackers.length}]`;
    case 'declareBlockers':
      return `declareBlockers[${a.blocks.length}]`;
    default:
      return a.kind;
  }
}

/** Every instance the game currently knows about, with the zone it claims to be in. */
function allInstances(state: GameState): { inst: CardInstance; actualZone: string }[] {
  const out: { inst: CardInstance; actualZone: string }[] = [];
  for (const inst of state.battlefield) out.push({ inst, actualZone: 'battlefield' });
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid];
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

/**
 * Check every invariant against a settled state. Returns the violations found.
 * `settled` means: between actions, with nothing mid-resolution.
 */
function checkInvariants(state: GameState): { invariant: string; detail: string }[] {
  const found: { invariant: string; detail: string }[] = [];
  const record = (invariant: string, detail: string) => found.push({ invariant, detail });

  const instances = allInstances(state);

  // --- "a card vanished / got duplicated" ------------------------------------
  const seen = new Map<number, string>();
  for (const { inst, actualZone } of instances) {
    const prior = seen.get(inst.instanceId);
    if (prior !== undefined) {
      record('unique instance ids', `#${inst.instanceId} (${inst.def.name}) is in both ${prior} and ${actualZone}`);
    }
    seen.set(inst.instanceId, actualZone);
  }

  // --- "the card says it's in my hand but it's on the battlefield" -----------
  for (const { inst, actualZone } of instances) {
    if (inst.zone !== actualZone) {
      record(
        'instance.zone matches its actual zone',
        `#${inst.instanceId} (${inst.def.name}) is in ${actualZone} but claims zone="${inst.zone}"`,
      );
    }
  }

  // --- "something on the battlefield should be dead" ------------------------
  // State-based actions run after every action, so no creature may sit on the
  // battlefield with 0 toughness or lethal damage marked.
  const cont = indexContinuous(state);
  for (const inst of state.battlefield) {
    if (!isCreature(inst.def)) continue;
    const toughness = effectiveToughness(inst, cont.get(inst.instanceId) ?? NO_MOD);
    if (toughness <= 0) {
      record('creatures with 0 toughness die', `#${inst.instanceId} ${inst.def.name} has toughness ${toughness}`);
    } else if (inst.damageMarked >= toughness) {
      record(
        'creatures with lethal damage die',
        `#${inst.instanceId} ${inst.def.name} has ${inst.damageMarked} damage vs toughness ${toughness}`,
      );
    }
  }

  // --- "I'm at 0 life and still playing" ------------------------------------
  for (const pid of PLAYER_IDS) {
    if (state.players[pid].life <= 0 && !state.gameOver) {
      record('a player at 0 life has lost', `${pid} is at ${state.players[pid].life} but the game is not over`);
    }
  }

  // --- "I played four lands this turn" --------------------------------------
  for (const pid of PLAYER_IDS) {
    const played = state.players[pid].landsPlayedThisTurn;
    // The cap is the BASE plus every "play an additional land" permanent the
    // seat controls — the engine's own answer, so this audit cannot disagree
    // with the rule it is auditing.
    if (played > maxLandPlaysFor(state, pid, DEFAULT_RULES)) {
      record('land drops are capped', `${pid} played ${played} lands this turn`);
    }
  }

  // --- combat bookkeeping ----------------------------------------------------
  // NOTE: an attacker or blocker LEAVING the battlefield mid-combat is legal and
  // expected (removal, first-strike deaths), and the declared lists deliberately
  // keep it — "once blocked, stays blocked" (CR 509.1b) depends on that history.
  // So we check the relationships, not that every id is still alive.
  if (state.combat) {
    for (const id of state.combat.attackers) {
      const a = state.battlefield.find((c) => c.instanceId === id);
      if (a && !isCreature(a.def)) {
        record('attackers are creatures', `#${id} ${a.def.name} is attacking but is not a creature`);
      }
    }
    for (const [blockerId, attackerId] of Object.entries(state.combat.blocks)) {
      if (!state.combat.attackers.includes(attackerId)) {
        record('blockers block a declared attacker', `#${blockerId} blocks #${attackerId}, which is not attacking`);
      }
    }
  }

  // --- "the game state has a negative/absurd number" ------------------------
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid];
    for (const zone of ['library', 'hand', 'graveyard', 'exile'] as const) {
      if (p[zone].length < 0) record('zone sizes are non-negative', `${pid}.${zone} = ${p[zone].length}`);
    }
    if (poolTotal(p.manaPool) < 0) record('mana pools are non-negative', `${pid} pool total < 0`);
  }

  return found;
}

/** Play one seeded game, checking invariants after every action. */
function auditGame(deckAName: string, deckBName: string, seed: number): Violation[] {
  const deckA = loadDeck(SAMPLE_DECKS.find((d) => d.name === deckAName)!, pool);
  const deckB = loadDeck(SAMPLE_DECKS.find((d) => d.name === deckBName)!, pool);
  const pilotA = ai.getPilot(HEURISTIC_PILOT_ID)!;
  const pilotB = ai.getPilot(HEURISTIC_PILOT_ID)!;
  const pilots: Record<PlayerId, typeof pilotA> = { A: pilotA, B: pilotB };

  let state = createGame({
    seed,
    decks: { A: { cards: deckA.library }, B: { cards: deckB.library } },
    registry,
  }).state;

  const rngs: Record<PlayerId, ReturnType<typeof createRng>> = {
    A: createRng(seed * 2 + 1),
    B: createRng(seed * 2 + 2),
  };

  const violations: Violation[] = [];
  const seenInvariants = new Set<string>();

  // Card conservation: the set of instance ids that exist at the start. Tokens add
  // new ids (legal), but an ORIGINAL card must never simply vanish.
  const originalIds = new Set(allInstances(state).map((e) => e.inst.instanceId));

  let lastTurn = state.turnNumber;

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
    const before = { turn: state.turnNumber, step: state.step };
    state = applyAction(state, action, DEFAULT_RULES, registry).state;

    const found = checkInvariants(state);

    // Turn-boundary invariants: things a player checks the instant their turn
    // starts. Evaluated once, the moment the turn number changes.
    if (state.turnNumber !== lastTurn) {
      lastTurn = state.turnNumber;
      const active = state.activePlayer;
      for (const inst of state.battlefield) {
        if (inst.controller !== active) continue;
        if (inst.tapped) {
          found.push({
            invariant: 'your permanents untap at the start of your turn',
            detail: `#${inst.instanceId} ${inst.def.name} is still tapped on turn ${state.turnNumber}`,
          });
        }
        if (isCreature(inst.def) && inst.summoningSick) {
          found.push({
            invariant: 'summoning sickness wears off on your turn',
            detail: `#${inst.instanceId} ${inst.def.name} is still summoning sick on turn ${state.turnNumber}`,
          });
        }
      }
      for (const inst of state.battlefield) {
        if (inst.damageMarked !== 0) {
          found.push({
            invariant: 'marked damage clears in the cleanup step',
            detail: `#${inst.instanceId} ${inst.def.name} still has ${inst.damageMarked} damage on turn ${state.turnNumber}`,
          });
        }
      }
      const stale = state.continuous.filter((e) => e.duration === 'endOfTurn');
      if (stale.length > 0) {
        found.push({
          invariant: '"until end of turn" effects expire',
          detail: `${stale.length} endOfTurn effect(s) survived into turn ${state.turnNumber}`,
        });
      }
      // An original card must still exist somewhere.
      const present = new Set(allInstances(state).map((e) => e.inst.instanceId));
      for (const id of originalIds) {
        if (!present.has(id)) {
          found.push({
            invariant: 'cards never vanish from the game',
            detail: `original instance #${id} is in no zone on turn ${state.turnNumber}`,
          });
          break;
        }
      }
    }

    for (const v of found) {
      // Report each distinct invariant once per game so one systemic break does
      // not bury the others.
      const key = `${v.invariant}|${v.detail}`;
      if (seenInvariants.has(v.invariant)) continue;
      seenInvariants.add(v.invariant);
      violations.push({
        invariant: v.invariant,
        detail: v.detail,
        seed,
        turn: before.turn,
        step: before.step,
        action: describeAction(action),
      });
      void key;
    }
  }
  return violations;
}

function formatViolations(vs: readonly Violation[]): string {
  return vs
    .map((v) => `  ✗ ${v.invariant}\n      ${v.detail}\n      (seed ${v.seed}, turn ${v.turn}, ${v.step}, after ${v.action})`)
    .join('\n');
}

describe('rules audit — full games against the real card pool', () => {
  // Every gauntlet deck appears at least once, so a card that only one archetype
  // plays still gets its invariants audited across full games.
  const matchups: [string, string][] = [
    ['Mono-Red Aggro', 'Mono-Green Ramp'],
    ['UW Control', 'Izzet Prowess'],
    ['Golgari Midrange', 'Boros Aggro'],
    ['Rakdos Goblins', 'Orzhov Lifegain'],
  ];

  for (const [a, b] of matchups) {
    it(`holds every basic invariant across ${AUDIT_GAMES} games of ${a} vs ${b}`, () => {
      const all: Violation[] = [];
      for (let seed = 1; seed <= AUDIT_GAMES; seed++) {
        all.push(...auditGame(a, b, seed));
      }
      expect(all.length, `\n${formatViolations(all)}\n`).toBe(0);
    });
  }
});
