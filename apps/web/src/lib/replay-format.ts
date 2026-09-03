/**
 * Pure event → text formatter for the replay log (DESIGN §1 DRY: ONE place turns a
 * `GameEvent` into a human line; the UI never hand-writes event prose). Side-effect
 * free and DOM-free, so it is unit-tested in Node.
 *
 * A name resolver maps an instanceId to a card name (events like `damageDealt` /
 * `tapped` carry only an id — the worker hands us an instance→name map). Unknown
 * ids degrade to a readable placeholder, never a crash (DESIGN §6).
 *
 * Many events are low-level bookkeeping (priority passes, mana add/empty, untap,
 * step boundaries other than turn begin) — those format to `null` and the log
 * skips them, keeping the feed readable. The fold (`replay-fold`) still counts ALL
 * events; this only governs what the human-readable feed shows.
 */
import type { GameEvent, PlayerId } from '@jonny-boi/core';

/** Resolve an instanceId to a display name (worker-provided map, with fallback). */
export type NameResolver = (instanceId: number) => string;

/** A formatted log line: who/what plus an optional emphasis tone for styling. */
export interface LogLine {
  readonly text: string;
  /** Emphasis tone → a CSS modifier; absent for plain lines. */
  readonly tone?: 'cast' | 'damage' | 'death' | 'life' | 'trigger' | 'turn' | 'waste' | 'win';
}

/** Friendly seat label ("Player A" / "Player B"). Used when no deck name is handy. */
export function seatLabel(player: PlayerId): string {
  return player === 'A' ? 'A' : 'B';
}

/** A target that is either a player or a permanent → readable text. */
function targetName(target: number | PlayerId, name: NameResolver): string {
  return target === 'A' || target === 'B' ? `Player ${target}` : name(target);
}

/**
 * Describe one event for the human log, or `null` to omit it (bookkeeping noise).
 * `name` resolves instance ids; pass a resolver that falls back gracefully.
 */
export function describeEvent(event: GameEvent, name: NameResolver): LogLine | null {
  switch (event.type) {
    case 'gameStart':
      return { text: `Game begins — Player ${event.startingPlayer} on the play.`, tone: 'turn' };
    case 'turnBegin':
      return { text: `Turn ${event.turn} — Player ${event.activePlayer}.`, tone: 'turn' };
    case 'landPlayed':
      return { text: `Player ${event.player} plays ${name(event.instanceId)}.` };
    case 'spellCast':
      return { text: `Player ${event.player} casts ${event.name}.`, tone: 'cast' };
    case 'stackResolved':
      return { text: `${event.name} resolves.` };
    case 'attackersDeclared': {
      if (event.attackers.length === 0) return null;
      const list = event.attackers.map((id) => name(id)).join(', ');
      return { text: `Attacks with ${list}.`, tone: 'damage' };
    }
    case 'blockersDeclared': {
      if (event.blocks.length === 0) return null;
      const list = event.blocks
        .map((b) => `${name(b.blocker)} blocks ${name(b.attacker)}`)
        .join('; ');
      return { text: `Blocks: ${list}.` };
    }
    case 'damageDealt':
      return {
        text: `${name(event.source)} deals ${event.amount} to ${targetName(event.target, name)}.`,
        tone: 'damage',
      };
    case 'damagePrevented':
      return {
        text: `Protection prevents ${event.amount} damage from ${name(event.source)} to ${targetName(event.target, name)}.`,
      };
    case 'lifeChanged':
      return {
        text: `Player ${event.player} ${event.delta >= 0 ? 'gains' : 'loses'} ${Math.abs(
          event.delta,
        )} life (now ${event.to}).`,
        tone: 'life',
      };
    case 'poisonChanged':
      // The poison clock (§3.105), phrased like the life line above.
      return {
        text: `Player ${event.player} gets ${event.delta} poison counter${event.delta === 1 ? '' : 's'} (now ${event.to}).`,
        tone: 'life',
      };
    case 'gainLife':
      // Paired with the `lifeChanged` that precedes it (see `changeLife` in
      // packages/cards), so printing both duplicated every life-gain in the replay
      // log. `lifeChanged` also carries the resulting total, so it wins.
      return null;
    case 'creatureDied':
      return { text: `${event.name} dies.`, tone: 'death' };
    case 'tokenCreated':
      return { text: `Player ${event.controller} creates ${event.name}.`, tone: 'cast' };
    case 'tokenCopyCreated':
      return { text: `Player ${event.controller}'s token is a copy of ${event.name}.`, tone: 'cast' };
    case 'spellCopied':
      return { text: `Player ${event.controller} copies ${event.name}.`, tone: 'cast' };
    case 'spellCopyCeasedToExist':
      // CR 704.5e — and it is emitted INSTEAD of a `zoneChange`, so a reader
      // folding this log must not put the object in a graveyard.
      return { text: `The copy of ${event.name} ceases to exist.` };
    case 'delayedTriggerCreated':
      // CR 603.7. Worth its own line, and not bookkeeping: it is the entire
      // drawback of the hasty token that just arrived, and a reader who could
      // not see it would be looking at a permanent creature.
      return { text: `Delayed: ${event.label}.`, tone: 'trigger' };
    case 'delayedTriggerFired':
      // The moment arrived. `triggerPutOnStack` follows for the same ability —
      // from here it IS an ordinary trigger — so this line says only that the
      // delayed one is what set it off.
      return { text: `Delayed ability triggers: ${event.label}.`, tone: 'trigger' };
    case 'triggerPutOnStack':
      return { text: `Trigger: ${event.label}.`, tone: 'trigger' };
    case 'triggeredAbilityResolved':
      return { text: `${event.label} resolves.`, tone: 'trigger' };
    case 'counterAdded':
      return {
        text: `${name(event.instanceId)} gets ${event.amount} ${event.kind} counter${
          event.amount === 1 ? '' : 's'
        }.`,
      };
    case 'chosenAsEnters':
      // Public, and printed as such — see the same case in `play/play-format.ts`.
      return { text: `${event.name} names ${event.described}.`, tone: 'trigger' };
    case 'continuousEffectAdded':
      return { text: `${name(event.targetInstanceId)} gets a temporary effect.` };
    // Mana left floating when a step ended: the pilot tapped a source and never
    // spent it. Surfaced because it is otherwise invisible — you can watch a
    // whole game and never learn a pilot burned two mana off a Sol Ring for
    // nothing, which is exactly the kind of misplay this viewer exists to catch.
    case 'manaPoolEmptied':
      return { text: `Player ${event.player} wasted unspent mana.`, tone: 'waste' };
    case 'playerLost':
      return { text: `Player ${event.player} loses — ${event.reason}.`, tone: 'death' };
    case 'gameOver':
      return {
        text: event.winner ? `Player ${event.winner} wins the game!` : 'The game is a draw.',
        tone: 'win',
      };
    // Bookkeeping the feed omits (still folded for state): priority, mana, untap,
    // step boundaries, effect/zone plumbing, continuous-effect expiry.
    default:
      return null;
  }
}
