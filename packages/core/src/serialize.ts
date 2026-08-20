/**
 * Debug/inspector seam: pure state serialization + a compact human-readable dump.
 * The web inspector (later) consumes `serializeState`; the event log is already
 * plain data and inspectable as-is. No I/O here — callers decide where output goes.
 */

import type { PendingChoice } from './choices.js';
import { choiceOptionCount } from './choices.js';
import type { CardInstance, GameState, PlayerId } from './state.js';
import { PLAYER_IDS } from './state.js';
import { poolTotal } from './mana.js';
import { effectivePower, effectiveToughness } from './internal/stats.js';
import { indexContinuous, NO_MOD } from './internal/continuous.js';
import { isBattle, isCreature, isPlaneswalker } from './card.js';
import { defenseOf, loyaltyOf } from './internal/stats.js';

/** A plain, JSON-safe snapshot of the game (no methods, no class instances). */
export interface SerializedState {
  readonly turnNumber: number;
  readonly activePlayer: PlayerId;
  readonly priorityPlayer: PlayerId;
  readonly step: string;
  readonly gameOver: boolean;
  readonly winner: PlayerId | null;
  readonly stackSize: number;
  readonly players: Record<
    PlayerId,
    {
      readonly life: number;
      readonly manaTotal: number;
      readonly handSize: number;
      readonly librarySize: number;
      readonly graveyardSize: number;
      readonly landsPlayedThisTurn: number;
      readonly hasLost: boolean;
    }
  >;
  readonly battlefield: ReadonlyArray<{
    readonly instanceId: number;
    readonly name: string;
    readonly controller: PlayerId;
    readonly tapped: boolean;
    readonly summoningSick: boolean;
    readonly power?: number;
    readonly toughness?: number;
    readonly damageMarked: number;
    /**
     * The permanent this one is attached to (an Aura's enchanted creature, an
     * Equipment's equipped creature). Present ONLY when actually attached, so a
     * board with no attachments serializes byte-for-byte as it always did.
     */
    readonly attachedTo?: number;
    /**
     * The value this permanent NAMED as it entered — "As ~ enters, choose a
     * creature type" (CR 614.1c). Present only when something was named, so a
     * board with no naming serializes byte-for-byte as it always did.
     *
     * It is here because it is the one piece of a naming permanent's state that
     * is invisible from the rest of the row: an Adaptive Automaton that named
     * Goblin and one that named Sliver dump identically without it, and a
     * bug report or a step-through of an anthem that "isn't working" is
     * unreadable when the answer is missing.
     */
    readonly chosenAsEntered?: string;
    /**
     * A planeswalker's current loyalty. Present only for walkers, so every
     * other board serializes byte-for-byte as it always did.
     */
    readonly loyalty?: number;
    /**
     * A battle's current defense. Present only for battles, so every other board
     * serializes byte-for-byte as it always did.
     */
    readonly defense?: number;
  }>;
  /**
   * The question the game is currently waiting on, if any — so the debug
   * inspector can show WHY a game is parked and who owes an answer, instead of a
   * board that mysteriously refuses to advance.
   */
  readonly pendingChoice?: {
    readonly id: number;
    readonly kind: string;
    readonly chooser: PlayerId;
    readonly prompt: string;
    readonly source: string;
    readonly min: number;
    readonly max: number;
    readonly optionCount: number;
  };
}

/** Produce a JSON-safe snapshot for the inspector / replay tooling. */
export function serializeState(state: GameState): SerializedState {
  const players = {} as SerializedState['players'];
  for (const pid of PLAYER_IDS) {
    const p = state.players[pid];
    players[pid] = {
      life: p.life,
      manaTotal: poolTotal(p.manaPool),
      handSize: p.hand.length,
      librarySize: p.library.length,
      graveyardSize: p.graveyard.length,
      landsPlayedThisTurn: p.landsPlayedThisTurn,
      hasLost: p.hasLost,
    };
  }
  const index = indexContinuous(state);
  return {
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    gameOver: state.gameOver,
    winner: state.winner,
    stackSize: state.stack.length,
    players,
    battlefield: state.battlefield.map((c: CardInstance) => {
      const mod = index.get(c.instanceId) ?? NO_MOD;
      return {
        instanceId: c.instanceId,
        name: c.def.name,
        controller: c.controller,
        tapped: c.tapped,
        summoningSick: c.summoningSick,
        power: isCreature(c.def) ? effectivePower(c, mod) : undefined,
        toughness: isCreature(c.def) ? effectiveToughness(c, mod) : undefined,
        damageMarked: c.damageMarked,
        ...(c.attachedTo != null ? { attachedTo: c.attachedTo } : {}),
        ...(c.chosenAsEntered ? { chosenAsEntered: c.chosenAsEntered } : {}),
        ...(isPlaneswalker(c.def) ? { loyalty: loyaltyOf(c) } : {}),
        ...(isBattle(c.def) ? { defense: defenseOf(c) } : {}),
      };
    }),
    ...(state.pendingChoice ? { pendingChoice: serializePendingChoice(state.pendingChoice) } : {}),
  };
}

/** Flatten a parked choice for the inspector (option counts, not option payloads). */
function serializePendingChoice(choice: PendingChoice): NonNullable<SerializedState['pendingChoice']> {
  return {
    id: choice.id,
    kind: choice.kind,
    chooser: choice.chooser,
    prompt: choice.prompt,
    source: choice.sourceName,
    min: choice.min,
    max: choice.max,
    optionCount: choiceOptionCount(choice),
  };
}

/** A terse one-screen text dump for quick debugging/log lines. */
export function dumpState(state: GameState): string {
  const s = serializeState(state);
  const lines: string[] = [];
  lines.push(`Turn ${s.turnNumber} | step=${s.step} | active=${s.activePlayer} | priority=${s.priorityPlayer}`);
  for (const pid of PLAYER_IDS) {
    const p = s.players[pid];
    lines.push(
      `  ${pid}: life=${p.life} hand=${p.handSize} lib=${p.librarySize} gy=${p.graveyardSize} mana=${p.manaTotal}` +
        (p.hasLost ? ' [LOST]' : ''),
    );
  }
  if (s.battlefield.length > 0) {
    lines.push('  battlefield:');
    for (const b of s.battlefield) {
      const pt =
        b.power !== undefined
          ? ` ${b.power}/${b.toughness}`
          : b.loyalty !== undefined
            ? ` [${b.loyalty} loyalty]`
            : b.defense !== undefined
              ? ` [${b.defense} defense]`
              : '';
      const flags = [b.tapped ? 'T' : '', b.summoningSick ? 'SS' : '', b.damageMarked ? `dmg${b.damageMarked}` : '']
        .filter(Boolean)
        .join(',');
      // "→[7]" reads as "attached to instance 7" — the one thing a dump of an
      // aura/equipment board is useless without.
      const attached = b.attachedTo !== undefined ? ` →[${b.attachedTo}]` : '';
      // "named:goblin" — what this permanent chose as it entered, without which
      // an anthem that "isn't working" is unreadable in a dump.
      const named = b.chosenAsEntered !== undefined ? ` named:${b.chosenAsEntered}` : '';
      lines.push(
        `    [${b.instanceId}] ${b.name}${pt} (${b.controller})${flags ? ` {${flags}}` : ''}${named}${attached}`,
      );
    }
  }
  if (s.stackSize > 0) lines.push(`  stack: ${s.stackSize} object(s)`);
  if (s.pendingChoice) {
    const c = s.pendingChoice;
    lines.push(`  awaiting ${c.kind} from ${c.chooser}: "${c.prompt}" (${c.min}-${c.max} of ${c.optionCount})`);
  }
  if (s.gameOver) lines.push(`  GAME OVER — winner: ${s.winner ?? 'draw'}`);
  return lines.join('\n');
}
