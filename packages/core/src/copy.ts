/**
 * COPY EFFECTS (CR 707) — "you may have ~ enter as a copy of …".
 *
 * A copy effect is the one modification in Magic that changes what an object
 * *is* rather than what it *has*, and CR 613.2 puts it in **LAYER 1 — beneath
 * every other layer**. That single fact is the whole feature, and it is what
 * this file exists to make impossible to get wrong:
 *
 *   layer 1  copy            ← here
 *   layer 4  type-changing
 *   layer 6  ability-adding
 *   layer 7a characteristic-defining P/T   (`derived.ts` / `characteristicPT`)
 *   layer 7c P/T modifications             (anthems, until-EOT pumps)
 *   layer 7d P/T counters                  (+1/+1 counters)
 *
 * So a copy is applied FIRST, and everything already pointed at the permanent —
 * its +1/+1 counters, the anthem shining on it, the Giant Growth cast on it last
 * turn, the Aura hanging off it — keeps applying **on top of the copied
 * characteristics**. Nothing about a permanent's per-object state is disturbed
 * by becoming a copy: it is the same object with a different card underneath.
 *
 * ## The mechanism: `def` IS the copy
 * A copy is expressed exactly the way a transformed face is (`transform.ts`) —
 * by swapping the instance's `def`. Every characteristic read in the codebase
 * already routes through `inst.def` (combat's P/T, targeting's types, the
 * trigger collector's ability list, mana production, the AI's evaluation, the
 * renderer's art), so the swap IS the routing and there is no second code path
 * anywhere. Layers 4–7 are then automatically ON TOP, because they are computed
 * from `inst.def` plus the instance's own state, which is precisely CR 613.2.
 *
 * The way back is {@link CardInstance.uncopiedDef} — the instance's OWN printed
 * card, restored by `resetInstanceForNewZone` when the permanent leaves the
 * battlefield (CR 707.2: the copy effect applies to the permanent, and a
 * permanent that changes zones is a new object).
 *
 * ⚠️ It is a SEPARATE field from `printedDef`, and that is not redundancy.
 * `printedDef` answers "which face is up"; `uncopiedDef` answers "which card is
 * this really". A copy of a transforming DFC can itself transform, at which
 * point `printedDef` holds the COPIED card's front face while `uncopiedDef`
 * still holds Clone — two different questions with two different answers, and
 * one field could only answer one of them.
 *
 * ## COPIABLE VALUES (CR 707.2) — the trap this system lives or dies on
 * What you copy is **the printed card**, as modified by other copy effects and
 * by "as … enters" choices — and by NOTHING else. Not counters, not anthems,
 * not until-end-of-turn pumps, not marked damage, not the face that happens to
 * be up. {@link copiableDefOf} is the single answer to that question, and every
 * copy path asks it rather than reading `inst.def` directly:
 *   - a **transformed** permanent is copied by its FRONT face — copy a
 *     transformed Delver of Secrets and you get a 1/1 Delver, not a 3/2
 *     Insectile Aberration;
 *   - a permanent that is ITSELF a copy is copied by what it copies — a Clone
 *     copying a Bear is copied as a Bear, never as a 0/0 Clone;
 *   - a 1/1 with three +1/+1 counters is copied as a **1/1**, and the copy's own
 *     counters (of which it has none) are then applied in layer 7d.
 */

import type { CardDefinition, CardType, KeywordFlags } from './card.js';
import { unionProtection } from './card.js';
import type { ManaColor } from './mana.js';
import type { CardFilter, CardOption } from './choices.js';
import { cardOption, choiceOptionCount, matchesCardFilter, normalizeChoiceRequest } from './choices.js';
import type { CardInstance, GameState, InstanceId } from './state.js';
import { PLAYER_IDS } from './state.js';
import type { GameEvent } from './events.js';

/**
 * Where the objects a card may copy live. `'battlefield'` is every printed
 * "as a copy of any creature on the battlefield"; `'graveyard'` is Echoing
 * Deeps' "as a copy of any land card in a graveyard" — a CARD, not a permanent,
 * which copies identically because {@link copiableDefOf} answers for both.
 */
export type CopySourceZone = 'battlefield' | 'graveyard';

/**
 * Appended to the copied card's id to form the copy's own definition id.
 *
 * The same convention (and the same reason) as the transform system's
 * `#back`: the id has to say "this is a DERIVED definition, not the pool's row
 * for that card", because the "except …" tail may have changed the name, the
 * types or the counters. Consumers that resolve art and display data decode the
 * prefix; consumers that join decklists never see one, because a copy exists
 * only on the battlefield.
 */
export const COPY_ID_SUFFIX = '#copy';

/**
 * The printed "**except** …" tail of a copy effect (CR 707.3): the copiable
 * values of the copy are the copied ones as modified by the copy effect itself.
 *
 * Data, never a per-card branch. Each field is one printed clause:
 * "except it's an artifact in addition to its other types" is
 * `addTypes: ['artifact']`; "except it's an Illusion in addition to its other
 * types" is `addSubtypes: ['Illusion']`; "except its name is Sakashima the
 * Impostor" is `name`; "except it isn't legendary" is `legendary: false`.
 *
 * Applied in {@link applyCopyExceptions}, which is a PURE function of the copied
 * definition — so the same Clone copying the same Bear always produces the same
 * definition, and the result can be compared, serialized and cached.
 */
export interface CopyExceptions {
  /** "except its name is ~" — the copy keeps its own name (Sakashima). */
  readonly name?: string;
  /** "except it's an artifact in addition to its other types" (Phyrexian Metamorph). */
  readonly addTypes?: readonly CardType[];
  /** "except it's an Illusion in addition to its other types" (Phantasmal Image). */
  readonly addSubtypes?: readonly string[];
  /** "except it has flying" — keywords the copy gains on top of the copied set. */
  readonly addKeywords?: KeywordFlags;
  /**
   * "except it isn't legendary" (Spark Double) / "except it's legendary in
   * addition to its other types" (Sakashima). `undefined` keeps whatever the
   * copied card printed — which is NOT the same as `false`, and getting that
   * wrong hands a player a second copy of a legend they should have lost to the
   * legend rule.
   */
  readonly legendary?: boolean;
  /**
   * "You may have this land **enter tapped** as a copy of …" (Vesuva). An
   * override, because the copied land's own `entersTapped` is usually false and
   * the copying card's printed word is what governs.
   */
  readonly entersTapped?: boolean;
  /**
   * "except it enters with an additional +1/+1 counter on it if it's a creature"
   * (Spark Double). Counters are per-object state, applied in layer 7d on top of
   * the copied 7a/7c values — so this really is "and then put a counter on it",
   * not a change to the copied P/T.
   */
  readonly extraCounters?: Readonly<Record<string, number>>;
  /**
   * "…an additional loyalty counter on it if it's a planeswalker" (Spark
   * Double). Kept apart from {@link extraCounters} because loyalty is entered
   * with (CR 306.5b), not added afterwards, and only a planeswalker has any.
   */
  readonly extraLoyalty?: number;
  // --- §3.111 the graveyard-casting family's "except" clauses --------------------
  /**
   * "except it's **white**" (embalm, CR 702.128a) / "**black**" (eternalize,
   * 702.129a) — the copy's colour, replacing the copied one. The same field
   * `CardDefinition.colors` already defines as "printed colour" (an empty list
   * is colourless), so a white Zombie token is white for protection, filters
   * and fear exactly as a printed white card is.
   */
  readonly colors?: readonly ManaColor[];
  /**
   * "except … it has **no mana cost**" (embalm, eternalize). The copy drops the
   * copied cost and is marked as CR 202.1b's no-cost object: its mana value is
   * zero and it can never be cast by paying a cost.
   */
  readonly noManaCost?: boolean;
  /** "except it's a **4/4** …" (eternalize) — the copy's base power. */
  readonly power?: number;
  /** "except it's a **4/4** …" (eternalize) — the copy's base toughness. */
  readonly toughness?: number;
}

/**
 * The printed "**you may have ~ enter as a copy of …**" replacement effect
 * (CR 614.1c + CR 707.9), declared as data on the card.
 *
 * It lives on the DEFINITION rather than in `effects` on purpose: it is an
 * as-enters REPLACEMENT, in exactly the family the engine already models with
 * `entersTapped` / `entersTappedUnlessLifePaid` / `entersTappedUnlessRevealed`,
 * and it must be asked at *every* entry path (a permanent spell resolving, a
 * land being played) rather than only where a resolution frame happens to run.
 * One authoring place, asked by the engine at each entry.
 */
export interface CopyAsEntersSpec {
  /** Which objects may be copied ("any **creature**", "any **artifact**"). */
  readonly filter?: CardFilter;
  /** Where they are. Defaults to the battlefield. */
  readonly from?: CopySourceZone;
  /**
   * `'you'` restricts the choice to objects the entering permanent's controller
   * controls/owns ("a creature **you control**" — Spark Double). Absent means
   * "any", which is what most of these cards print.
   */
  readonly whose?: 'you';
  /** The printed "except …" tail, if any. */
  readonly except?: CopyExceptions;
}

/**
 * **CR 707.2 — the copiable values of an object.** What another object gets
 * when it copies this one: the printed card, as modified by copy effects and
 * as-enters choices, and by nothing else.
 *
 * Three cases, and the ORDER of the two tests matters:
 *  1. a TRANSFORMED permanent is copied by its front face (CR 707.2 explicitly:
 *     "the copiable values are the values of the front face"), which is
 *     `printedDef`;
 *  2. a permanent that is itself a COPY is copied by what it copies — which is
 *     already `def`, since a copy swaps `def`;
 *  3. everything else is simply its own definition.
 *
 * Case 1 is tested first because a copy that has since transformed is BOTH, and
 * the front face of the copied card is the right answer for it too.
 *
 * A SPLIT/ADVENTURE card needs no case of its own, and that is worth saying
 * because it looks like it should. A split card is never a permanent, so an
 * as-enters copy can never be pointed at one; and an ADVENTURER on the
 * battlefield already carries its creature half in `def` (the cast path swapped
 * it there and parked the CR 709.4 combined object in `printedDef`), which is
 * exactly the set of characteristics CR 715.2 says such a permanent has. So
 * `def` is the right answer for it by construction, and `isBackFace` is false
 * on a primary half, which keeps it out of case 1.
 */
export function copiableDefOf(inst: {
  readonly def: CardDefinition;
  readonly printedDef?: CardDefinition | null;
}): CardDefinition {
  const base = inst.def.isBackFace === true && inst.printedDef != null ? inst.printedDef : inst.def;
  // ⚠️ TOKEN-NESS IS NOT A COPIABLE VALUE (CR 707.2). A copy takes the copied
  // object's CHARACTERISTICS; whether the object is a token is a fact about how
  // it was created (CR 111.1), and a card that becomes a copy of a token is
  // still a card.
  //
  // Getting this wrong DELETES A REAL CARD FROM THE GAME. `ceaseToExistIfToken`
  // removes any object leaving the battlefield whose definition says token —
  // correct for tokens, and for a Glasspool Mimic that entered as a copy of a
  // Thopter token it means the actual card is removed from every zone when it
  // dies, never reaching its owner's graveyard. A soak over the whole printed
  // pool caught it as "original instance #61 is in no zone on turn 37" (§3.71);
  // the old pool simply never dealt a copy effect and a token maker together.
  //
  // Stripped HERE because this is the one funnel that answers "what is the
  // copiable definition" — the token-making path stamps `isToken` back on after
  // calling it (`createTokenInState`), which is exactly the right order.
  if (base.isToken !== true) return base;
  const { isToken: _notCopiable, ...copiable } = base;
  return copiable;
}

/** Whether this permanent is currently a copy of something else (CR 707). */
export function isCopy(inst: { readonly uncopiedDef?: CardDefinition | null }): boolean {
  return inst.uncopiedDef != null;
}

/**
 * Add subtypes without duplicates, case-insensitively (subtypes are compared
 * case-insensitively everywhere else — see `hasSubtype`). Returns the original
 * list unchanged when nothing is added, so the no-exception path allocates
 * nothing.
 */
function addSubtypesTo(
  base: readonly string[] | undefined,
  extra: readonly string[] | undefined,
): readonly string[] | undefined {
  if (extra === undefined || extra.length === 0) return base;
  if (base === undefined || base.length === 0) return extra;
  const have = new Set(base.map((s) => s.toLowerCase()));
  const missing = extra.filter((s) => !have.has(s.toLowerCase()));
  return missing.length === 0 ? base : [...base, ...missing];
}

/** Add card types without duplicates. Same allocate-nothing rule as subtypes. */
function addTypesTo(base: readonly CardType[], extra: readonly CardType[] | undefined): readonly CardType[] {
  if (extra === undefined || extra.length === 0) return base;
  const missing = extra.filter((t) => !base.includes(t));
  return missing.length === 0 ? base : [...base, ...missing];
}

/**
 * Merge granted keywords onto a copied set. Booleans OR, protections UNION and
 * wards ADD — the same three merge rules the continuous layer's `grantInto`
 * uses, because "except it has flying" grants a keyword in exactly the sense a
 * pump does and two different answers would be a bug waiting to happen.
 */
function addKeywordsTo(
  base: KeywordFlags | undefined,
  extra: KeywordFlags | undefined,
): KeywordFlags | undefined {
  if (extra === undefined) return base;
  if (base === undefined) return extra;
  const merged: KeywordFlags = { ...base, ...extra };
  const protection = unionProtection(base.protectionFrom, extra.protectionFrom);
  const ward = (base.ward ?? 0) + (extra.ward ?? 0);
  return {
    ...merged,
    ...(protection !== undefined ? { protectionFrom: protection } : {}),
    ...(ward > 0 ? { ward } : {}),
  };
}

/**
 * **CR 707.3** — apply the printed "except …" tail to a set of copiable values,
 * producing the definition the copy actually has.
 *
 * PURE: it never touches an instance and never reads the game state, so a
 * caller can compute what a copy WOULD be (the AI ranking its options, a UI
 * previewing the choice) without mutating anything.
 *
 * The `id` gains {@link COPY_ID_SUFFIX} rather than being reused verbatim.
 * Reusing it would make a copied definition indistinguishable from the pool's
 * own row for that card — and the two differ, because the "except" tail changed
 * the types, the name or the counters. The suffixed form is decoded by the web
 * app's card resolver (exactly as `#back` is) to the COPIED card's display
 * record, so a Clone shows the art and type line of what it copied while still
 * never joining a decklist as that card.
 */
export function applyCopyExceptions(
  copied: CardDefinition,
  exceptions: CopyExceptions | undefined,
): CardDefinition {
  if (exceptions === undefined) return copied;
  const types = addTypesTo(copied.types, exceptions.addTypes);
  const subtypes = addSubtypesTo(copied.subtypes, exceptions.addSubtypes);
  const keywords = addKeywordsTo(copied.keywords, exceptions.addKeywords);
  const legendary = exceptions.legendary ?? copied.legendary;
  const next: CardDefinition = {
    ...copied,
    id: `${copied.id}${COPY_ID_SUFFIX}`,
    ...(exceptions.name !== undefined ? { name: exceptions.name } : {}),
    types,
    ...(subtypes !== undefined ? { subtypes } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(exceptions.entersTapped === true ? { entersTapped: true } : {}),
  };
  // §3.111 — the colour / cost / base-P/T exceptions embalm and eternalize print.
  const shaped = applyGraveyardCopyExceptions(next, exceptions);
  // Assigned rather than spread so `legendary: false` genuinely CLEARS the
  // copied card's legendary supertype (Spark Double's "and it isn't legendary")
  // instead of spreading an undefined that leaves it set.
  if (legendary === true) return { ...shaped, legendary: true };
  const cleared = { ...shaped } as { legendary?: boolean };
  delete cleared.legendary;
  return cleared as CardDefinition;
}

/**
 * §3.111 — the "except" clauses the graveyard-casting family prints, applied
 * on top of the type/subtype/keyword ones above: "it's white" / "it's black"
 * (the colour REPLACES the copied one — CR 702.128a's token is white whatever
 * the card was), "it has no mana cost" (the cost is REMOVED and the CR 202.1b
 * marker set, so its mana value reads zero), and "it's a 4/4" (the base P/T
 * replaces the copied one, in layer 7a; counters still apply on top).
 * A no-op — the same object back — when none of the four is printed.
 */
function applyGraveyardCopyExceptions(copied: CardDefinition, exceptions: CopyExceptions): CardDefinition {
  if (
    exceptions.colors === undefined &&
    exceptions.noManaCost !== true &&
    exceptions.power === undefined &&
    exceptions.toughness === undefined
  ) {
    return copied;
  }
  const shaped: { -readonly [K in keyof CardDefinition]: CardDefinition[K] } = { ...copied };
  if (exceptions.colors !== undefined) shaped.colors = [...exceptions.colors];
  if (exceptions.noManaCost === true) {
    delete shaped.cost;
    shaped.noManaCost = true;
  }
  if (exceptions.power !== undefined) shaped.power = exceptions.power;
  if (exceptions.toughness !== undefined) shaped.toughness = exceptions.toughness;
  return shaped;
}

/**
 * What a permanent WOULD become if it copied `source` under `spec` — the pure
 * half of {@link applyCopyAsEnters}, exported so the AI can rank its options and
 * a UI can preview one without mutating a thing.
 */
export function copyResultDef(self: CardDefinition, source: CardInstance, spec: CopyAsEntersSpec): CardDefinition {
  void self; // the copying card contributes nothing but its spec (CR 707.3)
  return applyCopyExceptions(copiableDefOf(source), spec.except);
}

/**
 * The empty "except" tail. Shared and frozen so {@link tokenCopyDefOf} can force
 * the id suffix without allocating a fresh object per token — a kicked Rite of
 * Replication makes five in one resolution.
 */
const NO_COPY_EXCEPTIONS: CopyExceptions = Object.freeze({});

/**
 * The copiable values a **TOKEN COPY** of `source` is created with (CR 707.2),
 * after the printed "except …" tail (CR 707.3).
 *
 * The other half of the copy family: everything above copies ONTO an object that
 * already exists (a Clone swapping its own `def`), while "create a token that's a
 * copy of target creature" CREATES one. What the two share is this file's single
 * answer to "what do you get when you copy that" — {@link copiableDefOf} — so a
 * token copy of a 1/1 wearing three counters is a **1/1**, a token copy of a
 * transformed permanent is its FRONT face, and a token copy of a Clone is
 * whatever the Clone copies. There is no second opinion anywhere.
 *
 * Always routed through {@link applyCopyExceptions}, even with nothing to apply,
 * so the result ALWAYS carries {@link COPY_ID_SUFFIX}. That is not cosmetic: an
 * unsuffixed id would make a token copy of Grizzly Bears indistinguishable from
 * the pool's own row for Grizzly Bears to anything keying on `def.id`, and the
 * object is emphatically not that card. The suffixed form is already decoded by
 * the web app's card resolver to the COPIED card's art and display record,
 * exactly as an as-enters copy's is.
 *
 * `isToken` is deliberately NOT stamped here. Token-ness is a property of HOW an
 * object was created, and `createTokenInState` is where creation happens — one
 * place, not two. Its own note already names this function's output as the case
 * it exists to cover, so the blank-definition trap is disarmed before a caller
 * can reach it.
 */
export function tokenCopyDefOf(source: CardInstance, except?: CopyExceptions): CardDefinition {
  return applyCopyExceptions(copiableDefOf(source), except ?? NO_COPY_EXCEPTIONS);
}

/**
 * Make `inst` a copy of `source` (CR 707, layer 1) as it enters the battlefield.
 *
 * Everything per-object is deliberately UNTOUCHED — this is a layer-1 change to
 * what the permanent is, not a zone change and not a reset. The one thing it
 * writes besides `def` is {@link CardInstance.uncopiedDef}, the way back.
 *
 * Safe by construction: copying something that is already what you are, or
 * copying with no source, does nothing rather than throwing. The copy is applied
 * BEFORE the permanent is put onto the battlefield by every caller, so the
 * entering permanent's summoning sickness, `entersTapped`, starting loyalty and
 * starting defense are all read off the COPIED card — which is what CR 614.1c
 * ("as it enters") means and what makes a copy of a planeswalker enter at the
 * copied loyalty.
 */
export function applyCopyAsEnters(
  inst: CardInstance,
  source: CardInstance,
  spec: CopyAsEntersSpec,
  emit: (e: GameEvent) => void,
): boolean {
  if (source.instanceId === inst.instanceId) return false;
  const own = inst.uncopiedDef ?? inst.def;
  const result = copyResultDef(own, source, spec);
  inst.uncopiedDef = own;
  inst.def = result;
  // A copy is a copy of the copiable (front-face) values, so the copy is
  // front-face-up whatever the thing it copied was showing (CR 707.2).
  if (inst.printedDef != null) inst.printedDef = null;
  const extra = spec.except?.extraCounters;
  if (extra !== undefined) {
    // Counters are layer 7d, applied ON TOP of the copied values — and the
    // record is REPLACED, never written into (see `CardInstance.counters`: the
    // empty case is a shared frozen object).
    let next: Record<string, number> | undefined;
    for (const kind in extra) {
      const amount = extra[kind] ?? 0;
      // "an additional +1/+1 counter on it IF IT'S A CREATURE" — the printed
      // condition, read off the characteristics the copy actually has.
      if (amount <= 0) continue;
      if (kind === '+1/+1' && !result.types.includes('creature')) continue;
      next ??= { ...inst.counters };
      next[kind] = (next[kind] ?? 0) + amount;
    }
    if (next !== undefined) inst.counters = next;
  }
  emit({
    type: 'becameCopy',
    instanceId: inst.instanceId,
    ownName: own.name,
    copiedName: result.name,
    copiedInstanceId: source.instanceId,
  });
  return true;
}

/**
 * The extra starting loyalty a copy enters with ("…an additional loyalty
 * counter on it if it's a planeswalker" — Spark Double). Zero for everything
 * else, so the ordinary entry path is unchanged.
 */
export function extraLoyaltyForCopy(inst: CardInstance, spec: CopyAsEntersSpec | undefined): number {
  const extra = spec?.except?.extraLoyalty ?? 0;
  if (extra <= 0) return 0;
  return inst.def.types.includes('planeswalker') ? extra : 0;
}

/**
 * The objects a card with `spec` could legally copy right now, in
 * battlefield/graveyard order (which is a stable, RNG-free order, so the
 * question a pilot is asked is reproducible from a seed).
 *
 * Excludes the entering permanent itself: it is not yet on the battlefield when
 * this is asked, but a card already in play that re-asks (or a hand-built state)
 * must not be offered itself.
 */
export function copyCandidates(state: GameState, self: CardInstance, spec: CopyAsEntersSpec): CardOption[] {
  const out: CardOption[] = [];
  const consider = (card: CardInstance): void => {
    if (card.instanceId === self.instanceId) return;
    if (spec.whose === 'you' && card.controller !== self.controller) return;
    if (!matchesCardFilter(card, spec.filter)) return;
    out.push(cardOption(card));
  };
  if ((spec.from ?? 'battlefield') === 'graveyard') {
    for (const pid of PLAYER_IDS) {
      for (const card of state.players[pid].graveyard) consider(card);
    }
    return out;
  }
  for (const card of state.battlefield) consider(card);
  return out;
}

/**
 * Raise the as-enters copy question for a permanent that is ABOUT TO ENTER, and
 * report whether a question was actually parked.
 *
 * The one seam both entry paths use (`resolveTopOfStack` for a permanent spell,
 * `applyPlayLand` for a land), so the two can never disagree about what is on
 * offer. `false` means the game continues immediately, which covers all three of
 * the honest "nothing to ask" cases:
 *   - the card prints no copy clause at all (every card in the game but a dozen);
 *   - it does, and there is nothing legal to copy — the printed "you may" then
 *     has exactly one outcome, and stopping the game for it would wedge a turn.
 */
export function askCopyAsEnters(state: GameState, card: CardInstance, emit: (e: GameEvent) => void): boolean {
  const spec = card.def.copyAsEnters;
  if (spec === undefined) return false;
  const candidates = copyCandidates(state, card, spec);
  if (candidates.length === 0) return false;
  const choice = normalizeChoiceRequest(
    {
      kind: 'selectCards',
      chooser: card.controller,
      // "You MAY have it enter as a copy" — 0 or 1, so declining is always a
      // legal answer and the question is never auto-answered away.
      min: 0,
      max: 1,
      candidates,
      prompt: `Have ${card.def.name} enter as a copy of…`,
      // Becoming a 4/4 instead of the printed body is upside; a pilot with no
      // card knowledge should take it. The COPY-SPECIFIC ranking (which of the
      // offered permanents is worth being) lives in the AI — see its
      // `copyAsEnters` branch, which ranks by COPIABLE values.
      valence: 'gain',
      ...(spec.from === 'graveyard' ? { fromZone: 'graveyard' as const } : { fromZone: 'battlefield' as const }),
    },
    { id: state.nextInstanceId++, sourceInstanceId: card.instanceId, sourceName: card.def.name },
  );
  if (!choice) return false;
  // `appliesToInstanceId` names the permanent the answer acts on, the same
  // convention the CR 614.1c naming uses: the two are only accidentally equal
  // today (the object asking IS the object becoming a copy), and an answer that
  // acted on "whatever asked" would copy onto the wrong permanent the first time
  // a source ever asks on another's behalf.
  state.pendingChoice = { ...choice, context: 'copyAsEnters', appliesToInstanceId: card.instanceId };
  state.priorityPlayer = choice.chooser;
  state.consecutivePasses = 0;
  emit({
    type: 'choiceAsked',
    choiceId: choice.id,
    chooser: choice.chooser,
    choiceKind: choice.kind,
    prompt: choice.prompt,
    sourceInstanceId: choice.sourceInstanceId,
    optionCount: choiceOptionCount(choice),
  });
  return true;
}

/**
 * Apply the answer to {@link askCopyAsEnters}: an empty selection is the printed
 * decline (the permanent enters as itself), and a chosen id copies that object.
 *
 * Tolerant of a candidate that has gone (a choice can outlive its options in a
 * hand-built state): the copy simply does not happen, which is the outcome that
 * cannot play better than the printed card.
 */
export function applyCopyAsEntersAnswer(
  state: GameState,
  card: CardInstance,
  chosen: readonly InstanceId[],
  emit: (e: GameEvent) => void,
): boolean {
  const spec = card.def.copyAsEnters;
  const id = chosen[0];
  if (spec === undefined || id === undefined) return false;
  const source = findCopySource(state, id, spec);
  if (!source) return false;
  return applyCopyAsEnters(card, source, spec, emit);
}

/** Locate a chosen copy source in the zone the spec draws from. */
function findCopySource(state: GameState, id: InstanceId, spec: CopyAsEntersSpec): CardInstance | undefined {
  if ((spec.from ?? 'battlefield') === 'graveyard') {
    for (const pid of PLAYER_IDS) {
      for (const card of state.players[pid].graveyard) if (card.instanceId === id) return card;
    }
    return undefined;
  }
  for (const card of state.battlefield) if (card.instanceId === id) return card;
  return undefined;
}
