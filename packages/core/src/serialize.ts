/**
 * Debug/inspector seam: pure state serialization + a compact human-readable dump.
 * The web inspector (later) consumes `serializeState`; the event log is already
 * plain data and inspectable as-is. No I/O here — callers decide where output goes.
 */

import type { CardInstance, GameState, PlayerId } from './state.js';
import { PLAYER_IDS } from './state.js';
import { poolTotal } from './mana.js';
import { effectivePower, effectiveToughness } from './internal/stats.js';
import { isCreature } from './card.js';

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
  }>;
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
  return {
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    gameOver: state.gameOver,
    winner: state.winner,
    stackSize: state.stack.length,
    players,
    battlefield: state.battlefield.map((c: CardInstance) => ({
      instanceId: c.instanceId,
      name: c.def.name,
      controller: c.controller,
      tapped: c.tapped,
      summoningSick: c.summoningSick,
      power: isCreature(c.def) ? effectivePower(c) : undefined,
      toughness: isCreature(c.def) ? effectiveToughness(c) : undefined,
      damageMarked: c.damageMarked,
    })),
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
      const pt = b.power !== undefined ? ` ${b.power}/${b.toughness}` : '';
      const flags = [b.tapped ? 'T' : '', b.summoningSick ? 'SS' : '', b.damageMarked ? `dmg${b.damageMarked}` : '']
        .filter(Boolean)
        .join(',');
      lines.push(`    [${b.instanceId}] ${b.name}${pt} (${b.controller})${flags ? ` {${flags}}` : ''}`);
    }
  }
  if (s.stackSize > 0) lines.push(`  stack: ${s.stackSize} object(s)`);
  if (s.gameOver) lines.push(`  GAME OVER — winner: ${s.winner ?? 'draw'}`);
  return lines.join('\n');
}
