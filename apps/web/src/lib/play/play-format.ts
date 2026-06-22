/**
 * Pure event → text formatter for the hotseat game log (DESIGN §1 DRY: ONE place
 * turns a `GameEvent` into a human line). Owned by the play feature (apps/web) — a
 * deliberate independent copy of the same idea the match-viewer uses, so the play
 * loop doesn't couple to the replay viewer's internals. Side-effect-free and
 * DOM-free, so it is unit-tested in Node.
 *
 * Unlike the replay formatter (which labels seats "Player A/B"), this one resolves
 * BOTH instance ids → card names AND player ids → the human's chosen seat name, so
 * the live log reads naturally ("Alice casts Lightning Bolt", "Bob's Goblin Guide
 * dies"). Low-level bookkeeping (priority/mana/untap/steps) formats to `null` and
 * the feed skips it; the session still keeps every event for the inspector.
 */
import type { GameEvent, InstanceId, PlayerId } from '@jonny-boi/core';

/** Resolve an instanceId to a display name (with a graceful fallback). */
export type NameResolver = (instanceId: InstanceId) => string;

/** Resolve a player id to their chosen seat name. */
export type PlayerNameResolver = (player: PlayerId) => string;

/** A formatted log line: text plus an optional emphasis tone for styling. */
export interface LogLine {
  readonly text: string;
  readonly tone?: 'cast' | 'damage' | 'death' | 'life' | 'trigger' | 'turn' | 'win';
}

/** Resolvers bundled together (passed once per format call). */
export interface LogResolvers {
  readonly name: NameResolver;
  readonly playerName: PlayerNameResolver;
}

/** A target token (player or permanent) → readable text. */
function targetText(target: InstanceId | PlayerId, r: LogResolvers): string {
  return target === 'A' || target === 'B' ? r.playerName(target) : r.name(target);
}

/**
 * Describe one event for the human log, or `null` to omit it (bookkeeping noise).
 * Robust: unknown ids degrade via the resolvers, never throwing.
 */
export function describeEvent(event: GameEvent, r: LogResolvers): LogLine | null {
  switch (event.type) {
    case 'gameStart':
      return { text: `Game begins — ${r.playerName(event.startingPlayer)} is on the play.`, tone: 'turn' };
    case 'turnBegin':
      return { text: `Turn ${event.turn} — ${r.playerName(event.activePlayer)}'s turn.`, tone: 'turn' };
    case 'landPlayed':
      return { text: `${r.playerName(event.player)} plays ${r.name(event.instanceId)}.` };
    case 'spellCast':
      return { text: `${r.playerName(event.player)} casts ${event.name}.`, tone: 'cast' };
    case 'stackResolved':
      return { text: `${event.name} resolves.` };
    case 'attackersDeclared': {
      if (event.attackers.length === 0) return null;
      const list = event.attackers.map((id) => r.name(id)).join(', ');
      return { text: `Attacks with ${list}.`, tone: 'damage' };
    }
    case 'blockersDeclared': {
      if (event.blocks.length === 0) return { text: 'No blocks.' };
      const list = event.blocks.map((b) => `${r.name(b.blocker)} blocks ${r.name(b.attacker)}`).join('; ');
      return { text: `Blocks: ${list}.` };
    }
    case 'damageDealt':
      return {
        text: `${r.name(event.source)} deals ${event.amount} to ${targetText(event.target, r)}.`,
        tone: 'damage',
      };
    case 'lifeChanged':
      return {
        text: `${r.playerName(event.player)} ${event.delta >= 0 ? 'gains' : 'loses'} ${Math.abs(event.delta)} life (now ${event.to}).`,
        tone: 'life',
      };
    case 'gainLife':
      return { text: `${r.playerName(event.player)} gains ${event.amount} life.`, tone: 'life' };
    case 'creatureDied':
      return { text: `${event.name} dies.`, tone: 'death' };
    case 'tokenCreated':
      return { text: `${r.playerName(event.controller)} creates ${event.name}.`, tone: 'cast' };
    case 'triggerPutOnStack':
      return { text: `Trigger: ${event.label}.`, tone: 'trigger' };
    case 'triggeredAbilityResolved':
      return { text: `${event.label} resolves.`, tone: 'trigger' };
    case 'counterAdded':
      return {
        text: `${r.name(event.instanceId)} gets ${event.amount} ${event.kind} counter${event.amount === 1 ? '' : 's'}.`,
      };
    case 'playerLost':
      return { text: `${r.playerName(event.player)} loses — ${event.reason}.`, tone: 'death' };
    case 'gameOver':
      return {
        text: event.winner ? `${r.playerName(event.winner)} wins the game!` : 'The game is a draw.',
        tone: 'win',
      };
    case 'actionRejected':
      // Surfaced separately in the UI (a toast), not in the running narrative.
      return null;
    default:
      return null;
  }
}

/** Format a batch of events to non-null lines, in order. */
export function describeEvents(events: readonly GameEvent[], r: LogResolvers): LogLine[] {
  const lines: LogLine[] = [];
  for (const e of events) {
    const line = describeEvent(e, r);
    if (line) lines.push(line);
  }
  return lines;
}
