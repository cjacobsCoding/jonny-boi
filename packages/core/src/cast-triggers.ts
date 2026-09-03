/**
 * CAST TRIGGERS — "When you cast this spell, …" abilities that function on the
 * STACK (DESIGN §3.113): storm (CR 702.40a), cascade (CR 702.85a), ripple
 * (CR 702.60a).
 *
 * ## Why these are not `CardDefinition.triggers`
 * The trigger collector (`internal/triggers-runtime.ts`) walks the battlefield
 * and the command zones on EVERY emitted event, and it is one of the hottest
 * loops in the engine. A storm spell's ability exists only while the spell is
 * on the stack, and it fires on exactly one event — the spell's own `spellCast`
 * — so scanning the stack on every event for a mechanic most games never see
 * would tax every game for the benefit of a few cards. The cast site already
 * knows the one moment that matters, so it pushes the ability itself — the
 * same road ward takes (`pushWardTriggers`), and for the same reason: "you cast
 * this" is a moment only the engine sees.
 *
 * ## One record, three keywords
 * A cast trigger is a LABEL, a KEYWORD tag and an effect list — the body is the
 * cards package's primitive (`stormCopies`, `cascade`, `ripple`), handed over
 * exactly as a suspend's tick or a cycling body is, so core names no primitive.
 * The keyword tag exists for the two readers that must not parse a label: the
 * pilot (which prices a storm spell by the spells cast before it and a cascade
 * spell by the free spell it expects) and the sweep guard in the compiler.
 *
 * ## "For each other spell that was cast before it this turn"
 * Storm's count is the number of spells cast this turn BEFORE the storm spell,
 * by any player (CR 702.40a). It is read once, as the trigger is pushed, and
 * rides the stack object as {@link TriggeredStackObject.triggeringAmount} —
 * the same field "that much" rides — so a spell cast in RESPONSE to the storm
 * trigger is not counted, exactly as the rule says. The count itself is the
 * turn-scoped `GameState.spellsCastThisTurn`, fed at the one event chokepoint
 * every other turn fact is fed at (`recordTurnFacts`); by the time this runs
 * the storm spell's own `spellCast` has been counted, hence the `- 1`.
 */

import type { EffectRef } from './card.js';
import type { GameEvent } from './events.js';
import type { GameState, SpellStackObject } from './state.js';
import { spellsCastThisTurn } from './turn-facts.js';

/** The keywords whose printed line compiles to a cast trigger. */
export type CastTriggerKeyword = 'storm' | 'cascade' | 'ripple';

/**
 * One "when you cast this spell" ability. A card printing the keyword twice
 * ("Cascade, cascade" — Maelstrom Wanderer) carries two records, because each
 * instance triggers separately (CR 702.85a is one ability per instance; storm
 * and ripple say so in 702.40b / 702.60b).
 */
export interface CastTriggeredAbility {
  readonly keyword: CastTriggerKeyword;
  /** The printed line, for the log ("Storm", "Cascade", "Ripple 4"). */
  readonly label: string;
  /** The body, run when the trigger resolves — a cards-package primitive. */
  readonly effects: readonly EffectRef[];
}

/**
 * Push every cast trigger of a spell that has just been cast, above the spell
 * (the caster controls them; they resolve first). Copies of spells are never
 * CAST (CR 707.10), so `copySpell` never reaches here and a storm copy does not
 * storm again.
 *
 * Called from the cast path immediately after the `spellCast` event has been
 * emitted, so the turn's spell count already includes this spell.
 */
export function pushCastTriggers(state: GameState, spell: SpellStackObject, emit: (e: GameEvent) => void): void {
  const triggers = spell.card.def.castTriggers;
  if (triggers === undefined || triggers.length === 0) return;
  const spellsBefore = Math.max(0, spellsCastThisTurn(state) - 1);
  for (const trigger of triggers) {
    state.stack.push({
      kind: 'trigger',
      instanceId: state.nextInstanceId++,
      sourceInstanceId: spell.instanceId,
      controller: spell.controller,
      effects: trigger.effects,
      targets: [],
      label: trigger.label,
      triggeringAmount: spellsBefore,
    });
    emit({
      type: 'triggerPutOnStack',
      sourceInstanceId: spell.instanceId,
      controller: spell.controller,
      label: trigger.label,
    });
  }
}

/** Whether `def` prints `keyword` as a cast trigger, and how many times. */
export function castTriggerCount(
  def: { readonly castTriggers?: readonly CastTriggeredAbility[] },
  keyword: CastTriggerKeyword,
): number {
  const triggers = def.castTriggers;
  if (triggers === undefined) return 0;
  let count = 0;
  for (let i = 0; i < triggers.length; i++) if (triggers[i]!.keyword === keyword) count += 1;
  return count;
}
