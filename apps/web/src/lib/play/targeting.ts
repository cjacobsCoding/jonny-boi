/**
 * Targeting inference for the hotseat client (pure, DOM-free, unit-tested).
 *
 * The engine resolves a spell's targets at cast time and passes them to its effect
 * primitives as `ctx.targets`, but a `CardDefinition` does NOT carry an explicit
 * "needs a target" flag — the requirement is implicit in which primitives the card's
 * effects reference. To present a correct interactive cast flow (click card → pick
 * target → pay → cast) we must derive, from card DATA, whether a target is needed
 * and what is a legal target.
 *
 * We classify a card's effect primitives against a small table (composition over
 * inheritance — a data table, not a class per card): some primitives consume a
 * creature/permanent target, some a player target, some "any target" (a creature
 * OR a player, e.g. Lightning Bolt's `dealDamage`). A card with no targeting
 * primitive needs no target. This stays in lock-step with the `cards` package's
 * primitives by id; an unknown primitive contributes no requirement (safe default).
 */
import type {
  CardDefinition,
  CardInstance,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import { isCreature, isPlaneswalker, isTargetRestriction } from '@jonny-boi/core';

/**
 * What kind of thing a target must be. Mirrors core's `TargetRestriction` for the
 * kinds the curated pool's HAND-CAST spells declare: `'any'` includes planeswalkers
 * (CR 115.4), and the two compound kinds are the printed "player or planeswalker" /
 * "creature or planeswalker" lines.
 */
export type TargetKind =
  | 'creature'
  | 'player'
  | 'any'
  | 'spell'
  | 'playerOrPlaneswalker'
  | 'creatureOrPlaneswalker';

/**
 * The targeting requirement of a card: how many targets, of what kind. `count` 0
 * means the card needs no target (cast directly). We model single-target cards
 * (the whole curated pool's targeted spells take exactly one), but keep `count`
 * explicit so it isn't a hidden assumption.
 */
export interface TargetRequirement {
  readonly count: number;
  readonly kind: TargetKind;
}

/** No-target requirement (the common case). */
export const NO_TARGET: TargetRequirement = Object.freeze({ count: 0, kind: 'any' });

/** Whether a core restriction word is one this UI models as a `TargetKind`. */
function isTargetKind(value: string): value is TargetKind {
  return (
    value === 'creature' ||
    value === 'player' ||
    value === 'any' ||
    value === 'spell' ||
    value === 'playerOrPlaneswalker' ||
    value === 'creatureOrPlaneswalker'
  );
}

/**
 * Primitive id → the kind of target it consumes. Mirrors `@jonny-boi/cards`'s
 * `CORE_PRIMITIVES`. Primitives absent from this map don't target (createToken,
 * drawCards, gainLife on self, destroyAll, addMana, …). `dealDamage` is "any
 * target" (creature or player). Removal (`destroyTarget`/`exileTarget`/`tapTarget`)
 * and `pumpUntilEndOfTurn`/`grantKeywordUntilEndOfTurn` take a creature.
 * `counterSpell` takes a spell on the stack.
 *
 * Note: some primitives target ONLY when a param is set (e.g. `gainLife` with
 * `targetPlayer: true`). Those are handled in {@link requirementForEffect}.
 */
const PRIMITIVE_TARGET_KIND: Readonly<Record<string, TargetKind>> = Object.freeze({
  dealDamage: 'any',
  destroyTarget: 'creature',
  exileTarget: 'creature',
  tapTarget: 'creature',
  pumpUntilEndOfTurn: 'creature',
  grantKeywordUntilEndOfTurn: 'creature',
  counterSpell: 'spell',
});

/**
 * The target requirement contributed by one effect ref, accounting for params that
 * gate whether targeting actually happens (`gainLife`/`loseLife` only target a
 * player when `targetPlayer` is true; pump/grant target the SOURCE when cast with
 * no target — but as a hand spell with no implicit source creature, a creature
 * target is expected, so we require one).
 */
function requirementForEffect(primitive: string, params?: Readonly<Record<string, unknown>>): TargetRequirement {
  if ((primitive === 'gainLife' || primitive === 'loseLife') && params?.targetPlayer === true) {
    return { count: 1, kind: 'player' };
  }
  const kind = PRIMITIVE_TARGET_KIND[primitive];
  if (!kind) return NO_TARGET;
  // A card may narrow its own aim with the engine's reserved `targets` param
  // (core's TargetRestriction): Lava Spike is player-only, Flame Slash
  // creature-only, even though both are `dealDamage`. The engine ENFORCES that
  // restriction, so a UI that offered the wider table kind would present a target
  // the cast is then rejected for — a dead end for the player. The declared
  // restriction therefore wins; the table is only the default for cards that
  // don't declare one.
  const declared = params?.targets;
  if (isTargetRestriction(declared) && isTargetKind(declared)) {
    return { count: 1, kind: declared };
  }
  return { count: 1, kind };
}

/**
 * Derive a card's overall targeting requirement from its effects. Takes the first
 * (most specific) targeting effect — the curated pool's targeted cards each target
 * once. Cards whose effects only resolve as an ETB script when entering the
 * battlefield (permanents) generally don't choose a target from hand; we still
 * read their effects so a hypothetical targeted-ETB is handled, but most permanents
 * return NO_TARGET.
 */
export function targetRequirement(def: CardDefinition): TargetRequirement {
  for (const ref of def.effects ?? []) {
    const req = requirementForEffect(ref.primitive, ref.params);
    if (req.count > 0) return req;
  }
  return NO_TARGET;
}

/** Whether casting this card requires the player to choose a target. */
export function needsTarget(def: CardDefinition): boolean {
  return targetRequirement(def).count > 0;
}

/**
 * The state a target search actually reads: the public battlefield and stack.
 * Narrower than `GameState` so the ONLINE client — which only ever holds a
 * redacted view — can enumerate targets with the same code the hotseat uses.
 */
export interface TargetableView {
  readonly battlefield: readonly CardInstance[];
  readonly stack: readonly GameState['stack'][number][];
}

/** A legal target option presented to the player: a creature, a planeswalker, a player, or a spell. */
export type TargetOption =
  | { readonly kind: 'creature'; readonly instanceId: InstanceId; readonly name: string; readonly controller: PlayerId }
  | { readonly kind: 'planeswalker'; readonly instanceId: InstanceId; readonly name: string; readonly controller: PlayerId }
  | { readonly kind: 'player'; readonly player: PlayerId; readonly name: string }
  | { readonly kind: 'spell'; readonly instanceId: InstanceId; readonly name: string; readonly controller: PlayerId };

/**
 * Enumerate the legal targets for a requirement against the current state. Pure:
 * reads the battlefield/stack/players, returns plain option records the UI renders
 * as clickable choices. Player names are supplied so the UI can label them.
 */
export function legalTargets(
  req: TargetRequirement,
  state: TargetableView,
  playerNames: Readonly<Record<PlayerId, string>>,
): readonly TargetOption[] {
  const options: TargetOption[] = [];
  const creatures: CardInstance[] = state.battlefield.filter((c) => isCreature(c.def));
  const walkers: CardInstance[] = state.battlefield.filter((c) => isPlaneswalker(c.def));

  const includesCreatures =
    req.kind === 'creature' || req.kind === 'any' || req.kind === 'creatureOrPlaneswalker';
  if (includesCreatures) {
    for (const c of creatures) {
      options.push({ kind: 'creature', instanceId: c.instanceId, name: c.def.name, controller: c.controller });
    }
  }
  // Planeswalkers are legal wherever core says they are: "any target" (CR 115.4)
  // and both compound restrictions — never for plain 'creature' or 'player'. A
  // hypothetical creature-planeswalker already listed as a creature is not repeated.
  if (req.kind === 'any' || req.kind === 'creatureOrPlaneswalker' || req.kind === 'playerOrPlaneswalker') {
    for (const w of walkers) {
      if (includesCreatures && isCreature(w.def)) continue;
      options.push({ kind: 'planeswalker', instanceId: w.instanceId, name: w.def.name, controller: w.controller });
    }
  }
  if (req.kind === 'player' || req.kind === 'any' || req.kind === 'playerOrPlaneswalker') {
    for (const pid of ['A', 'B'] as const) {
      options.push({ kind: 'player', player: pid, name: playerNames[pid] });
    }
  }
  if (req.kind === 'spell') {
    for (const obj of state.stack) {
      if (obj.kind === 'spell') {
        options.push({ kind: 'spell', instanceId: obj.instanceId, name: obj.card.def.name, controller: obj.controller });
      }
    }
  }
  return options;
}

/** Convert a chosen target option to the engine's target token (InstanceId | PlayerId). */
export function optionToTarget(option: TargetOption): InstanceId | PlayerId {
  return option.kind === 'player' ? option.player : option.instanceId;
}
