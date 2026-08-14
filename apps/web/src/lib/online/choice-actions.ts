/**
 * Online-play fallback for a parked player choice (DESIGN §3.11), and the honest
 * limits of it.
 *
 * ## What the wire carries today, and what it does not
 * The client→server half already works: `submitAction` takes any `GameAction`, and
 * `answerChoice` is one — the server hands it straight to the engine, which is the
 * only thing entitled to validate it.
 *
 * The server→client half does NOT: `MaskedGameView` has no `pendingChoice` field,
 * so a client is never told the question — only that its whole legal menu has
 * collapsed to a set of `answerChoice` actions. Without this module the online
 * board therefore renders a board with no playable control and no pass button: a
 * DEAD END, the one failure mode a game must never have.
 *
 * So this module makes the best honest offer from what the client actually has: the
 * engine's own bounded menu of legal answers, each labelled from public information
 * in the masked view. A yes/no reads correctly; a pick among battlefield/graveyard
 * cards reads correctly; a pick among cards the view cannot see degrades to the
 * card's id rather than inventing a name. The prompt text itself is simply not
 * available, and the UI says so instead of pretending.
 *
 * When `pendingChoice` is added to `MaskedGameView`, this module is replaced by the
 * hotseat's real `ChoicePrompt` and deleted.
 */
import type { GameAction, InstanceId, PlayerId } from '@jonny-boi/core';
import type { MaskedGameView } from '@jonny-boi/protocol';

/** An `answerChoice` action, narrowed out of the action union. */
export type AnswerChoiceAction = Extract<GameAction, { kind: 'answerChoice' }>;

/** One offerable answer: the action to send, plus a label built from public data. */
export interface OnlineChoiceOption {
  /** Stable React key — the choice id plus the answer's position in the menu. */
  readonly key: string;
  readonly action: AnswerChoiceAction;
  readonly label: string;
  /**
   * True when every card in the answer could be named from the masked view. A false
   * here is what the UI uses to warn that it is showing ids, not cards.
   */
  readonly fullyNamed: boolean;
}

/** The `answerChoice` actions in a server legal-action menu (empty when none). */
export function choiceAnswerActions(actions: readonly GameAction[]): readonly AnswerChoiceAction[] {
  return actions.filter((a): a is AnswerChoiceAction => a.kind === 'answerChoice');
}

/**
 * True when the server has left the client NOTHING but answering a question. This
 * is the exact condition the board must not dead-end on: a normal priority window
 * always contains at least `passPriority`.
 */
export function isAwaitingChoiceAnswer(actions: readonly GameAction[]): boolean {
  return actions.length > 0 && actions.every((a) => a.kind === 'answerChoice');
}

/** Every card the masked view lets this seat name, by instance id. */
function nameIndex(view: MaskedGameView): Map<InstanceId, string> {
  const index = new Map<InstanceId, string>();
  const add = (cards: readonly { instanceId: InstanceId; def: { name: string } }[]): void => {
    for (const c of cards) index.set(c.instanceId, c.def.name);
  };
  add(view.battlefield);
  for (const player of Object.values(view.players)) {
    add(player.graveyard);
    add(player.exile);
    // `hand` is non-null only for THIS seat — masking already did that work.
    if (player.hand) add(player.hand);
  }
  for (const obj of view.stack) {
    if (obj.kind === 'spell') index.set(obj.instanceId, obj.card.def.name);
  }
  return index;
}

/** Copy shown when an answer picks nothing (the declined branch of a "you may"). */
const DECLINE_LABEL = 'Choose none';

/**
 * Label one answer from public information. Never invents a name: a card the view
 * does not carry is rendered as its id, and the caller surfaces that honestly.
 */
function labelFor(
  action: AnswerChoiceAction,
  names: Readonly<Record<PlayerId, string>>,
  index: Map<InstanceId, string>,
): { label: string; fullyNamed: boolean } {
  const answer = action.answer;
  switch (answer.kind) {
    case 'confirm':
      return { label: answer.yes ? 'Yes' : 'No', fullyNamed: true };
    case 'selectPlayers':
      return answer.players.length === 0
        ? { label: DECLINE_LABEL, fullyNamed: true }
        : { label: answer.players.map((p) => names[p] ?? p).join(', '), fullyNamed: true };
    case 'chooseModes':
      return answer.modeIds.length === 0
        ? { label: DECLINE_LABEL, fullyNamed: true }
        : { label: answer.modeIds.join(', '), fullyNamed: false };
    default: {
      if (answer.instanceIds.length === 0) return { label: DECLINE_LABEL, fullyNamed: true };
      let fullyNamed = true;
      const parts = answer.instanceIds.map((id) => {
        const name = index.get(id);
        if (name) return name;
        fullyNamed = false;
        return `card #${id}`;
      });
      return { label: parts.join(', '), fullyNamed };
    }
  }
}

/**
 * Turn the server's legal `answerChoice` actions into labelled options. Order is
 * the server's, which is the engine's deterministic enumeration order — so the same
 * question always offers the same menu in the same order.
 */
export function onlineChoiceOptions(
  actions: readonly GameAction[],
  view: MaskedGameView,
  names: Readonly<Record<PlayerId, string>>,
): readonly OnlineChoiceOption[] {
  const answers = choiceAnswerActions(actions);
  if (answers.length === 0) return [];
  const index = nameIndex(view);
  return answers.map((action, i) => {
    const { label, fullyNamed } = labelFor(action, names, index);
    return { key: `${action.choiceId}:${i}`, action, label, fullyNamed };
  });
}
