/**
 * THE COMBO PROMPT'S VIEW MODEL — pure, DOM-free (DESIGN §3.178).
 *
 * The engine's `ComboWindow` names the loop as actions, deltas and a key; the
 * prompt needs the CARDS the loop runs through (to list, and to light up on
 * the board), the change in words, and the bounds of its number field. Derived
 * here once, so the prompt, the board highlight and the log agree on what the
 * loop is made of.
 */
import {
  COMBO_REPEAT_CAP,
  COMBO_REPEAT_DEFAULT,
  summarizeComboLoop,
  type ComboLoop,
  type ComboWindow,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { collectInstanceIds } from '@jonny-boi/protocol';

/** One game object the loop runs through, named for the prompt. */
export interface ComboPromptCard {
  readonly instanceId: InstanceId;
  readonly name: string;
}

/** Everything the prompt renders. */
export interface ComboPromptView {
  readonly owner: PlayerId;
  /** The distinct objects the cycle's actions name, in the order the cycle first names them. */
  readonly cards: readonly ComboPromptCard[];
  /** Applied actions per cycle, both seats' included. */
  readonly cycleLength: number;
  /** One phrase per moving resource — "+1 life", "+1 Saproling". */
  readonly changes: readonly string[];
  /** "+1 life, +1 Saproling per cycle". */
  readonly summary: string;
  /** What the number field starts at, and the most it accepts. */
  readonly defaultTimes: number;
  readonly cap: number;
}

/**
 * Every instance id the cycle's actions name — sources, targets, cost payers,
 * the objects inside a recorded answer — through the engine's own id
 * vocabulary (`collectInstanceIds` reads the field names `instance-ids.ts`
 * classifies), so a new kind of action that names a card is picked up the day
 * it is classified rather than the day somebody remembers this list.
 */
export function comboCycleInstanceIds(loop: ComboLoop): readonly InstanceId[] {
  const ordered: InstanceId[] = [];
  const seen = new Set<InstanceId>();
  for (const action of loop.cycle) {
    for (const id of collectInstanceIds(action)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/** Build the prompt's view. `nameOf` is the session's resolver, so an ability on the stack reads as its label. */
export function comboPromptView(window: ComboWindow, nameOf: (id: InstanceId) => string): ComboPromptView {
  return {
    owner: window.owner,
    cards: comboCycleInstanceIds(window.loop).map((instanceId) => ({ instanceId, name: nameOf(instanceId) })),
    cycleLength: window.loop.cycle.length,
    changes: window.loop.deltas.map((d) => d.label),
    summary: summarizeComboLoop(window.loop),
    defaultTimes: COMBO_REPEAT_DEFAULT,
    cap: COMBO_REPEAT_CAP,
  };
}

/**
 * What the number field's text means as a repeat count: a whole number from 1
 * to the cap, or `null` for anything else — the button is disabled rather than
 * the value quietly clamped, because "1000" typed as "10000" is a mistake the
 * player should see, not one the prompt should round.
 */
export function parseRepeatCount(text: string, cap: number = COMBO_REPEAT_CAP): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > cap) return null;
  return value;
}
