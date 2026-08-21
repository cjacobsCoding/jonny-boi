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
    case 'damagePrevented':
      // A swing that did nothing must SAY why, or the log reads like a bug.
      return {
        text: `Protection prevents ${event.amount} damage from ${r.name(event.source)} to ${targetText(event.target, r)}.`,
      };
    case 'counterPrevented':
      // Same argument as `damagePrevented`: a Counterspell that visibly did
      // nothing has to say why, or the log reads like a bug.
      return { text: `${event.name} can't be countered.` };
    case 'lifeChanged':
      return {
        text: `${r.playerName(event.player)} ${event.delta >= 0 ? 'gains' : 'loses'} ${Math.abs(event.delta)} life (now ${event.to}).`,
        tone: 'life',
      };
    case 'gainLife':
      // Every `gainLife` is emitted immediately after the `lifeChanged` for the
      // same gain (see `changeLife` in packages/cards), so rendering both printed
      // the line twice — "gains 2 life (now 22)" then "gains 2 life". `lifeChanged`
      // is the strictly more informative of the pair, so this one is bookkeeping.
      return null;
    case 'creatureDied':
      return { text: `${event.name} dies.`, tone: 'death' };
    case 'tokenCreated':
      return { text: `${r.playerName(event.controller)} creates ${event.name}.`, tone: 'cast' };
    case 'tokenCopyCreated':
      // Said IN ADDITION to `tokenCreated` (which fires for this object too),
      // because "a token" and "a token that is a copy of that creature" read as
      // very different board states to a player watching the log.
      return {
        text: `${r.playerName(event.controller)}'s token is a copy of ${event.name}.`,
        tone: 'cast',
      };
    case 'spellCopied':
      return { text: `${r.playerName(event.controller)} copies ${event.name}.`, tone: 'cast' };
    case 'delayedTriggerCreated':
      // CR 603.7 — an ability that now exists on NO object and fires later.
      // Printed rather than silent because it is the whole drawback of the token
      // that just arrived: without the line a player sees a free hasty creature.
      return { text: `Delayed: ${event.label}.`, tone: 'trigger' };
    case 'delayedTriggerFired':
      // Its moment arrived. `triggerPutOnStack` follows for the same ability —
      // from here it is an ordinary trigger — so this says only what set it off.
      return { text: `Delayed ability triggers: ${event.label}.`, tone: 'trigger' };
    case 'spellCopyCeasedToExist':
      // CR 704.5e. Worth a line rather than silence: without it a player sees a
      // second spell resolve and then sees nothing go to a graveyard, which
      // looks like a bug rather than the rule it is.
      return { text: `The copy of ${event.name} ceases to exist.` };
    case 'cardsLookedAt':
      // The COUNT only — the cards themselves are not public, and this shared
      // hotseat log is exactly the channel that must not leak them.
      return {
        text: `${r.playerName(event.player)} looks at the top ${event.amount} card${event.amount === 1 ? '' : 's'} of their library.`,
      };
    case 'triggerPutOnStack':
      return { text: `Trigger: ${event.label}.`, tone: 'trigger' };
    case 'triggeredAbilityResolved':
      return { text: `${event.label} resolves.`, tone: 'trigger' };
    case 'counterAdded':
      return {
        text: `${r.name(event.instanceId)} gets ${event.amount} ${event.kind} counter${event.amount === 1 ? '' : 's'}.`,
      };
    case 'chosenAsEnters':
      // NAMED OUT LOUD, unlike a choice answer. The value a permanent names as it
      // enters is announced at the table (CR 614.1c) and stays readable on the
      // card, so the log says it — the redaction two cases below is about a
      // chooser's private ANSWER, which this is not.
      return { text: `${event.name} names ${event.described}.`, tone: 'trigger' };
    case 'playerLost':
      return { text: `${r.playerName(event.player)} loses — ${event.reason}.`, tone: 'death' };
    case 'gameOver':
      return {
        text: event.winner ? `${r.playerName(event.winner)} wins the game!` : 'The game is a draw.',
        tone: 'win',
      };
    // --- player choices (DESIGN §3.11) ------------------------------------------
    // The log is shared by BOTH seats in hotseat, so these lines say that a question
    // was asked and answered WITHOUT naming the cards involved: a choice's candidate
    // list can contain hidden cards (the victim's hand), and the answer's summary is
    // raw instance ids. Naming them here would leak through the log what the masked
    // board view is careful not to show.
    case 'choiceAsked':
      return { text: `${r.playerName(event.chooser)} is asked: ${event.prompt}`, tone: 'trigger' };
    case 'choiceAnswered': {
      // A yes/no is the one answer that carries no card identity, so it is safe (and
      // useful) to say out loud; every other kind logs only that it was answered.
      const said = event.answer.kind === 'confirm' ? ` — ${event.answer.yes ? 'yes' : 'no'}` : '';
      return { text: `${r.playerName(event.chooser)} answers${said}.`, tone: 'trigger' };
    }
    case 'choiceAutoAnswered':
      // Only surfaced when the engine had to step in for a reason the players can
      // act on; a single-legal-answer auto-answer is bookkeeping, not narrative.
      return null;
    case 'choiceAbandoned':
      return { text: `${r.name(event.sourceInstanceId)} could not finish — ${event.reason}.`, tone: 'trigger' };
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
