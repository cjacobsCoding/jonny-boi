/**
 * WHAT THE OPPONENT JUST DID (pure, DOM-free, unit-tested) — §3.133.
 *
 * Reported: "the computer plays instant and sorcery spells and I have no idea
 * what they played… what they are targeting with their spells". The information
 * was all on screen and all TRANSIENT: the stack panel names a spell and its
 * targets perfectly, but the Solo board auto-passes, so an AI instant is cast
 * and resolved inside one burst and the panel may never render with it on. By
 * the time the player looks, the only trace is a line in the log.
 *
 * ## Why the ACTION list, not the event log
 * A `spellCast` EVENT carries the name but NOT the targets — targets live on the
 * stack object, which is gone by the time anyone looks. The accepted ACTION does
 * carry them (`castSpell.targets`), and `GameSession.actions` is the durable,
 * append-only record of every action the engine accepted. So this folds actions,
 * which means the note is exact and survives however fast the stack resolved.
 *
 * ## What it reports
 * Only the OPPONENT's plays, and only the ones a player cannot simply see: a
 * cast and an activated ability. A land drop is deliberately absent — it is
 * sitting on the battlefield, visible, and announcing it would be noise.
 */
import type { GameAction, InstanceId, PlayerId } from '@jonny-boi/core';

/** The kinds of opponent play worth announcing. */
export type OpponentActionKind = 'cast' | 'ability';

/** One thing the opponent did, ready to render. */
export interface OpponentActionNote {
  /** Absolute index in the action list — stable render identity, never reused. */
  readonly key: string;
  readonly kind: OpponentActionKind;
  /** What they played ("Lightning Strike"), resolved by the caller's labeller. */
  readonly name: string;
  /** What it pointed at, resolved to names ("Grizzly Bears", "Player 1"). */
  readonly targets: readonly string[];
}

/** What {@link describeOpponentActions} needs beside the actions. */
export interface DescribeOpponentOptions {
  /** The seat READING the board; anything they did themselves is not news. */
  readonly viewer: PlayerId;
  /** Absolute index of `actions[0]`, so keys never collide across batches. */
  readonly startIndex: number;
  /**
   * Resolve an instance id or a seat to a display name. The board passes
   * `GameSession.nameOf` plus its seat names, so a spell already in the
   * graveyard still resolves — `nameOf` searches every zone and the stack.
   */
  readonly label: (ref: InstanceId | PlayerId) => string;
}

/** Shared empty result so the common no-news frame allocates nothing. */
const NO_NOTES: readonly OpponentActionNote[] = Object.freeze([]);

/**
 * Fold a batch of freshly-accepted actions into the opponent plays worth
 * announcing. Order is action order, so a turn reads top-to-bottom as it happened.
 */
export function describeOpponentActions(
  actions: readonly GameAction[],
  opts: DescribeOpponentOptions,
): readonly OpponentActionNote[] {
  const out: OpponentActionNote[] = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i] as GameAction;
    if (action.kind !== 'castSpell' && action.kind !== 'activateAbility') continue;
    if (action.player === opts.viewer) continue; // your own plays are not news
    out.push({
      key: `${opts.startIndex + i}`,
      kind: action.kind === 'castSpell' ? 'cast' : 'ability',
      name: opts.label(action.instanceId),
      targets: (action.targets ?? []).map(opts.label),
    });
  }
  return out.length > 0 ? out : NO_NOTES;
}

/** The sentence a note reads as: "cast Lightning Strike → Grizzly Bears". */
export function describeNote(note: OpponentActionNote): string {
  const verb = note.kind === 'cast' ? 'cast' : 'activated';
  const aim = note.targets.length > 0 ? ` → ${note.targets.join(', ')}` : '';
  return `${verb} ${note.name}${aim}`;
}
