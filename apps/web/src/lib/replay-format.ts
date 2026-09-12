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

/**
 * What the feed says when a permanent LEAVES THE BATTLEFIELD for each zone.
 *
 * The independent twin of `play/play-format.ts`'s table of the same name, and
 * added for the same report (20260911_194411): an exile is carried by a bare
 * `zoneChange`, which formatted to `null`, so a viewer could watch a creature
 * vanish from the board and never be told where it went. `graveyard` is absent
 * because `creatureDied` already says it.
 */
const LEAVES_BATTLEFIELD_TEXT: Readonly<Record<string, (card: string) => string>> = Object.freeze({
  exile: (card) => `${card} is exiled.`,
  hand: (card) => `${card} returns to its owner's hand.`,
  library: (card) => `${card} is put into its owner's library.`,
});

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
    case 'zoneChange': {
      // See {@link LEAVES_BATTLEFIELD_TEXT} — the board change, not the plumbing.
      if (event.from !== 'battlefield') return null;
      const say = LEAVES_BATTLEFIELD_TEXT[event.to];
      return say ? { text: say(name(event.instanceId)), tone: 'death' } : null;
    }
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
    case 'triggerCopied':
      // Strionic Resonator (CR 707.10) — the other kind of stack object, and the
      // half this feed had no sentence for. Report 20260911_194411.
      return { text: `Player ${event.controller} copies ${event.label}.`, tone: 'trigger' };
    case 'abilityActivated':
      // The permanent the pilot CLICKED. Without it an activation reached the
      // feed only as its own oracle text, later, under `stackResolved`.
      return { text: `Player ${event.player} activates ${name(event.instanceId)}.`, tone: 'cast' };
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
    case 'triggerFizzled':
      // CR 603.4's intervening "if", and CR 608.2b's all-targets-illegal. The
      // ability left the stack having done nothing, and a feed that showed only
      // the abilities that DID something would be reporting a different game.
      return { text: `${event.label} — nothing happens (${event.reason}).`, tone: 'trigger' };
    case 'triggeredAbilityResolved':
      return { text: `${event.label} resolves.`, tone: 'trigger' };
    case 'triggerRemovedFromStack':
      // CR 603.3d — it never got a legal target. The same sentence the live
      // game log has said since §3.55, and for the same reason: an ability that
      // leaves the stack unannounced reads as a viewer bug.
      return { text: `${event.label} — nothing happens (${event.reason}).`, tone: 'trigger' };
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
    // --- SILENT BY DESIGN, FOREVER -------------------------------------------
    // Plumbing this feed exists to see PAST: priority, step boundaries, the mana
    // machine, effect/replacement/grant bookkeeping, and a pilot's own parked
    // questions — a replay that narrated every question an AI was asked would
    // bury the game in them.
    case 'stepBegin':
    case 'priorityPassed':
    case 'untapped':
    case 'tapped':
    case 'manaAdded':
    case 'manaCostPaid':
    case 'effectApplied':
    case 'effectUnsupported':
    case 'replacementApplied':
    case 'replacementExpired':
    case 'continuousEffectExpired':
    case 'cardGrantAdded':
    case 'cardGrantExpired':
    case 'triggerModesChosen':
    case 'triggerTargetsChosen':
    case 'modesChosen':
    case 'modeTargetChosen':
    case 'drawCard':
    case 'cardsMilled':
    case 'cardsLookedAt':
    case 'pileBottomed':
    case 'actionRejected':
    case 'choiceAsked':
    case 'choiceAnswered':
    case 'choiceAutoAnswered':
    case 'choiceAbandoned':
      return null;

    // --- SILENT, AND THAT IS A GAP -------------------------------------------
    // Real events with no sentence yet. Listed EXPLICITLY rather than swept up
    // by a `default`, because that `default` is exactly where `triggerCopied`
    // and `abilityActivated` hid until report 20260911_194411. Naming them makes
    // the debt countable and each one a ROW to fill in.
    case 'cardCycled':
    case 'madnessWindowOpened':
    case 'madnessDeclined':
    case 'cardSuspended':
    case 'suspendWindowOpened':
    case 'suspendDeclined':
    case 'cardExiledToCastLater':
    case 'cascadeWindowOpened':
    case 'rippleWindowOpened':
    case 'controlChanged':
    case 'counterPrevented':
    case 'loyaltyChanged':
    case 'planeswalkerDied':
    case 'defenseChanged':
    case 'battleDefeated':
    case 'legendRuleApplied':
    case 'emblemCreated':
    case 'becameRenowned':
    case 'cardRevealed':
    case 'regenerated':
    case 'permanentAttached':
    case 'permanentUnattached':
    case 'attachmentFailed':
    case 'attachmentPutIntoGraveyard':
    case 'transformed':
    case 'becameCopy':
    case 'tokenCeasedToExist':
      return null;

    default: {
      // EXHAUSTIVE, like the live log's. Adding a `GameEvent` type to core and
      // not deciding here FAILS THE BUILD. The runtime `return null` is for a
      // stored replay carrying an event this build no longer knows.
      const unclassified: never = event;
      void unclassified;
      return null;
    }
  }
}
