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
 * ⚠️ ONE ANSWER TO ONE QUESTION (CLAUDE.md rule 12). Bug report 20260901_211035
 * — "No conceivable way to actually target a creature with my Cloudshift spell"
 * — was this module answering "does this card target?" from its OWN table of
 * seven primitives while core's `TargetRestriction` had grown to thirty-odd
 * words and the pool used twenty-two primitives with a declared restriction.
 * Cloudshift's `blinkTarget` was not in the table, so the board cast it with no
 * target and the engine refused ("targets exactly one a creature you control"):
 * the card's only affordance was a toast. The requirement is now READ OFF CORE
 * (`targetRestrictionOf`) and the legal targets are ENUMERATED BY CORE
 * (`legalTargetsFor`, the same enumerator `generateLegalActions` uses), so a
 * restriction added to the engine is understood here in the same edit. What
 * remains local is the closed table of UNRESTRICTED targeting primitives — the
 * "any target" family core deliberately does not police — measured from the pool
 * (`dealDamage` 66 cards, the rest single digits).
 */
import type {
  CardDefinition,
  CardInstance,
  GameState,
  InstanceId,
  PlayerId,
  TargetRestriction,
} from '@jonny-boi/core';
import {
  isCreature,
  isPlaneswalker,
  isTargetRestriction,
  legalTargetsFor,
  targetRestrictionOf,
} from '@jonny-boi/core';

/**
 * What kind of thing a target must be — core's own closed vocabulary, so the UI
 * cannot know a word the engine does not, nor lack one the engine has. `'any'`
 * is MTG's "any target": a creature, a player, a planeswalker or a battle.
 */
export type TargetKind = TargetRestriction;

/**
 * The targeting requirement of a card: how many targets, of what kind. `count` 0
 * means the card needs no target (cast directly). We model single-target cards
 * (a hand-cast spell's `castSpell` action carries exactly one target), but keep
 * `count` explicit so it isn't a hidden assumption.
 */
export interface TargetRequirement {
  readonly count: number;
  readonly kind: TargetKind;
}

/** No-target requirement (the common case). */
export const NO_TARGET: TargetRequirement = Object.freeze({ count: 0, kind: 'any' });

/**
 * Primitive id → the kind of target it consumes WHEN THE CARD DECLARES NO
 * RESTRICTION. Core does not police an unrestricted ("any target") spell, so it
 * cannot tell us these target at all; the rows are the primitives the pool uses
 * without a `targets` param that nonetheless aim at something (measured:
 * `dealDamage` is 66 of them, the rest a handful each). A declared restriction
 * ALWAYS wins over this table — see {@link targetRequirement}.
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
  // A declared restriction is the printed aim, whatever the primitive: the
  // engine ENFORCES it, so a UI that offered the wider table kind would present
  // a target the cast is then rejected for — a dead end for the player.
  const declared = params?.targets;
  if (isTargetRestriction(declared)) return { count: 1, kind: declared };
  const kind = PRIMITIVE_TARGET_KIND[primitive];
  if (!kind) return NO_TARGET;
  return { count: 1, kind };
}

/**
 * Derive a card's overall targeting requirement from its effects.
 *
 * The restriction core ENFORCES (`targetRestrictionOf` — the narrowest declared
 * one, memoised per definition) wins outright: it is the exact word the engine
 * will validate the cast against. Only a card core leaves unpoliced falls
 * through to the effect-by-effect scan, which takes the first targeting effect
 * (the curated pool's targeted cards each target once). Cards whose effects only
 * resolve as an ETB script (permanents) generally return NO_TARGET.
 */
export function targetRequirement(def: CardDefinition): TargetRequirement {
  const enforced = targetRestrictionOf(def);
  if (enforced !== undefined) return { count: 1, kind: enforced };
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
 * The state a target search actually reads: the public battlefield and stack,
 * plus — when the caller holds a full engine state — the players' public zones,
 * which is what lets core's own enumerator answer for restrictions that reach a
 * graveyard ("target creature card in your graveyard"). Narrower than
 * `GameState` so the ONLINE client — which only ever holds a redacted view —
 * can enumerate the battlefield/stack kinds with the same code the hotseat uses.
 */
export interface TargetableView {
  readonly battlefield: readonly CardInstance[];
  readonly stack: readonly GameState['stack'][number][];
  readonly players?: GameState['players'];
}

/**
 * A legal target option presented to the player. `creature` / `planeswalker` /
 * `permanent` are things on the battlefield the player can also CLICK; `player`
 * is a seat; `spell` and `ability` are objects on the stack (a counterspell's
 * aim, Strionic Resonator's); `card` is a card in a public non-battlefield zone
 * (a graveyard reanimation target).
 */
export type TargetOption =
  | { readonly kind: 'creature'; readonly instanceId: InstanceId; readonly name: string; readonly controller: PlayerId }
  | { readonly kind: 'planeswalker'; readonly instanceId: InstanceId; readonly name: string; readonly controller: PlayerId }
  | { readonly kind: 'permanent'; readonly instanceId: InstanceId; readonly name: string; readonly controller: PlayerId }
  | { readonly kind: 'player'; readonly player: PlayerId; readonly name: string }
  | { readonly kind: 'spell'; readonly instanceId: InstanceId; readonly name: string; readonly controller: PlayerId }
  | { readonly kind: 'ability'; readonly instanceId: InstanceId; readonly name: string; readonly controller: PlayerId }
  | {
      readonly kind: 'card';
      readonly instanceId: InstanceId;
      readonly name: string;
      readonly controller: PlayerId;
      readonly zone: 'graveyard' | 'exile';
    };

/** The option kinds that sit on the battlefield, i.e. that a board tile can stand for. */
export function isBoardTargetOption(option: TargetOption): option is Extract<
  TargetOption,
  { kind: 'creature' | 'planeswalker' | 'permanent' }
> {
  return option.kind === 'creature' || option.kind === 'planeswalker' || option.kind === 'permanent';
}

/**
 * The kinds this module enumerates ITSELF. `'any'` because core does not police
 * it (nothing to ask core for); the other five are the pre-core vocabulary, kept
 * so a redacted view with no `players` can still enumerate them. When the view
 * IS a full state, core's enumerator answers for every kind but `'any'` — it is
 * the one that knows about hexproof, protection and "you control".
 */
const LOCALLY_ENUMERATED: ReadonlySet<TargetKind> = new Set<TargetKind>([
  'any',
  'creature',
  'player',
  'spell',
  'playerOrPlaneswalker',
  'creatureOrPlaneswalker',
]);

/**
 * Enumerate the legal targets for a requirement against the current state. Pure:
 * reads the battlefield/stack/players, returns plain option records the UI renders
 * as clickable choices. Player names are supplied so the UI can label them.
 *
 * `controller` (the caster) and `source` (the card being cast) are what core's
 * enumerator needs for "you control" / "an opponent controls" restrictions and
 * for protection checks; a caller that cannot supply them gets the local
 * enumeration for the classic kinds and NOTHING for a controller-scoped
 * restriction — the safe failure, never a target the engine would refuse.
 */
export function legalTargets(
  req: TargetRequirement,
  state: TargetableView,
  playerNames: Readonly<Record<PlayerId, string>>,
  controller?: PlayerId,
  source?: CardDefinition,
): readonly TargetOption[] {
  const canAskCore = req.kind !== 'any' && state.players !== undefined;
  if (canAskCore) {
    const refs = legalTargetsFor(state as GameState, req.kind, controller, source);
    return refs
      .map((ref) => describeRef(ref, state, playerNames))
      .filter((option): option is TargetOption => option !== undefined);
  }
  if (!LOCALLY_ENUMERATED.has(req.kind)) return [];
  return enumerateLocally(req, state, playerNames);
}

/** Turn one of core's target refs into a labeled option for the prompt. */
function describeRef(
  ref: InstanceId | PlayerId,
  state: TargetableView,
  playerNames: Readonly<Record<PlayerId, string>>,
): TargetOption | undefined {
  if (ref === 'A' || ref === 'B') return { kind: 'player', player: ref, name: playerNames[ref] };
  const onBoard = state.battlefield.find((c) => c.instanceId === ref);
  if (onBoard) {
    const kind = isCreature(onBoard.def) ? 'creature' : isPlaneswalker(onBoard.def) ? 'planeswalker' : 'permanent';
    return { kind, instanceId: ref, name: onBoard.def.name, controller: onBoard.controller };
  }
  for (const obj of state.stack) {
    if (obj.instanceId !== ref) continue;
    if (obj.kind === 'spell') return { kind: 'spell', instanceId: ref, name: obj.card.def.name, controller: obj.controller };
    return { kind: 'ability', instanceId: ref, name: obj.label, controller: obj.controller };
  }
  if (state.players) {
    for (const pid of ['A', 'B'] as const) {
      const player = state.players[pid];
      for (const zone of ['graveyard', 'exile'] as const) {
        const hit = player[zone].find((c) => c.instanceId === ref);
        if (hit) return { kind: 'card', instanceId: ref, name: hit.def.name, controller: pid, zone };
      }
    }
  }
  // An id core offered that no public zone explains: refuse to invent a row.
  return undefined;
}

/** The pre-core enumeration for the classic six kinds (see LOCALLY_ENUMERATED). */
function enumerateLocally(
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
