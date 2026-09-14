/**
 * The hidden-information VIEW MODEL (pure, DOM-free, unit-tested).
 *
 * Given the authoritative `GameState` and WHICH seat is currently viewing, build a
 * render-ready snapshot in which the *other* player's hand is masked to face-down
 * backs with only a count — never the card identities. This is the single chokepoint
 * that enforces the hotseat hidden-info guarantee (and, unchanged, the online
 * guarantee: a viewer only ever sees their own hand). The UI renders straight from
 * this model and cannot accidentally leak a hidden hand because the masked model
 * carries no identifying data for the opponent's cards.
 *
 * Effective power/toughness and keywords fold in continuous effects via the engine's
 * `indexContinuous` (DESIGN §3.9), so a pumped/granted creature shows correctly.
 */
import {
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
  explainCharacteristics,
  indexContinuous,
  isCreature,
  isLand,
  isBattle,
  isPlaneswalker,
  defenseOf,
  loyaltyOf,
  protectorOf,
  manaColorsOffered,
  MANA_COLORS,
  NO_MOD,
  PLUS_ONE_COUNTER,
  MINUS_ONE_COUNTER,
  LOYALTY_COUNTER,
  DEFENSE_COUNTER,
  type CardInstance,
  type CharacteristicExplanation,
  type CombatState,
  type ContinuousIndex,
  type GameState,
  type InstanceId,
  type KeywordFlags,
  type ManaPool,
  type PlayerId,
  poisonOf,
} from '@jonny-boi/core';
import { stackEntries, type StackEntry } from './stack-view.js';

/**
 * The six colour counts of a pool as a plain record — the shape every view, the
 * replay format and the online board expect.
 *
 * Spelled out rather than `{ ...pool }` ON PURPOSE: a pool carrying spend
 * restrictions also carries a `restricted` array, and spreading it into a
 * `Record<string, number>` would smuggle a non-number through a view type and
 * into the replay wire format. The restriction travels as
 * {@link poolRestrictionLabels} instead, which is a shape the UI can render.
 */
export function poolColorCounts(pool: ManaPool): Record<string, number> {
  const out: Record<string, number> = {};
  for (const color of MANA_COLORS) out[color] = pool[color];
  return out;
}

/** The printed spend restrictions on the mana currently floating, in add order. */
export function poolRestrictionLabels(pool: ManaPool): readonly string[] {
  const parcels = pool.restricted;
  if (parcels === undefined) return EMPTY_RESTRICTIONS;
  return parcels.map((parcel) => `${parcel.amount} {${parcel.color}} ${parcel.restriction.label}`);
}

/** Shared empty list so the ordinary pool allocates nothing to describe none. */
const EMPTY_RESTRICTIONS: readonly string[] = Object.freeze([]);

/**
 * A card the viewer is allowed to SEE — their own hand, either graveyard, and
 * the half of exile they are entitled to identify. Named for the hand because
 * that is where it started; the shape is "an identified card in a list", and
 * every zone that shows one uses it so no zone grows a renderer of its own.
 */
export interface VisibleHandCard {
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  readonly isLand: boolean;
}

/** A permanent on the battlefield, with effective stats folded in. */
export interface BoardPermanent {
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  readonly controller: PlayerId;
  readonly isCreature: boolean;
  readonly isLand: boolean;
  readonly isPlaneswalker: boolean;
  /** Current loyalty (from the loyalty counter); 0 for non-walkers. */
  readonly loyalty: number;
  readonly isBattle: boolean;
  /**
   * Current defense (from the defense counter); 0 for non-battles. A battle's
   * defense is its life total exactly as loyalty is a walker's, so the board
   * renders it the same way — a badge carrying the CURRENT value, never the
   * printed one.
   */
  readonly defense: number;
  /**
   * Who PROTECTS this battle — the seat that defends it, which is its
   * controller's opponent (CR 310.11). Carried so the board can say whose
   * Siege a player is attacking without re-deriving the rule in the UI.
   * `null` for everything that is not a battle.
   */
  readonly protector: PlayerId | null;
  readonly tapped: boolean;
  readonly summoningSick: boolean;
  /** EFFECTIVE power/toughness — printed, plus counters, plus continuous effects. */
  readonly power: number;
  readonly toughness: number;
  /**
   * ⚠️ SUPERSEDED ON THE HOTSEAT BOARD BY {@link BoardPermanent.explanation}
   * (§3.143 / UX-17), AND KEPT ONLY FOR THE ONLINE ONE.
   *
   * These three answered "the stats changed — by how much?" with a number and
   * no source, which is as far as a SUM can be pushed: `indexContinuous`
   * aggregates every continuous effect and throws the attribution away, so a
   * `ptDelta` badge could say "+1/+1" and never which enchantment supplied it.
   * Core now answers the whole question (`explainCharacteristics`), the tile
   * renders that, and `perm__pt-delta` is gone from the screen — two answers to
   * one question on one card is what rule 12 forbids.
   *
   * They survive because `lib/online/board-adapter.ts` constructs a
   * `BoardPermanent` by hand and has no engine to explain anything with (it
   * renders a server-masked view), so for THAT surface the counters-only delta
   * is still the most it can honestly say. Delete all three the day the online
   * board carries a real explanation.
   */
  readonly printedPower: number;
  readonly printedToughness: number;
  readonly ptDelta: { readonly power: number; readonly toughness: number } | null;
  /** See {@link BoardPermanent.ptDelta} — online-only, superseded on this board. */
  readonly ptFromEffects: { readonly power: number; readonly toughness: number } | null;
  /**
   * CORE'S OWN CHARACTERISTIC BREAKDOWN for this permanent — what is printed,
   * what is effective, and one attributed row per contributing source
   * (`explainCharacteristics`, packages/core/src/provenance.ts).
   *
   * This is what `CardFace` draws: the 5/6 in place of the 4/5, the granted
   * "flying" merged into the printed keyword line, and the hover breakdown that
   * names the enchantment.
   *
   * ⚠️ **LAZY** — see {@link explainerFor}. Reading it builds the breakdown on
   * demand (once per `buildBoardView` pass); not reading it costs nothing.
   *
   * Optional because the online adapter cannot produce one; `CardFace` states
   * that absence rather than drawing an empty breakdown, which would read as
   * "nothing is modifying this".
   */
  readonly explanation?: CharacteristicExplanation | undefined;
  /**
   * Counters ON this permanent, by kind, non-zero only. Loyalty and defense are
   * counters too but are excluded: they already have their own badges, and
   * saying it twice is noise.
   */
  readonly counters: readonly { readonly kind: string; readonly count: number }[];
  readonly damageMarked: number;
  readonly keywords: KeywordFlags;
  /** Mana this source can still produce this turn (empty when not a mana source or tapped). */
  readonly producesIfTapped: readonly string[];
  /**
   * COMBAT ROLE this frame (bug report 20260901_204854, "it needs to be way
   * more clear who is attacking"): `attacking` while the engine's combat state
   * lists it as an attacker, `blocking` naming the attacker it blocks once
   * blocks are declared. Both read straight off `state.combat`, which the
   * engine keeps from declaration through end of combat and clears with the
   * turn — so a creature is never drawn as attacking after combat is over.
   */
  readonly attacking: boolean;
  readonly blocking: InstanceId | null;
}

/**
 * A stack object rendered for the board.
 *
 * ⚠️ NOT A SHAPE OF ITS OWN ANY MORE. It is lane A's {@link StackEntry}, so the
 * panel that shows real card faces (UX-1) and the model the board hands it are
 * one type, produced by one function — `stackEntries`. The alias stays because
 * `BoardView.stack` and `lib/online/board-adapter.ts` both name it, and a rename
 * across an unowned file buys nothing.
 */
export type StackView = StackEntry;

/** One player's public/private snapshot from the viewer's perspective. */
export interface SeatView {
  readonly id: PlayerId;
  readonly name: string;
  readonly life: number;
  /** Poison counters (CR 122.1f, §3.105) — the second clock, beside life. */
  readonly poison: number;
  readonly handCount: number;
  /** Present ONLY when this seat is visible to the viewer; null when masked. */
  readonly hand: readonly VisibleHandCard[] | null;
  readonly libraryCount: number;
  readonly graveyardCount: number;
  /**
   * The graveyard's actual cards, oldest first. The graveyard is a PUBLIC zone
   * (CR 404.2), so this is present for BOTH seats — it is what lets either play
   * UI open a graveyard and offer flashback casts from it, not a leak.
   */
  readonly graveyard: readonly VisibleHandCard[];
  /**
   * How many cards are in exile ALTOGETHER — including the face-down ones whose
   * identity is withheld below. Their EXISTENCE is public (the table watched the
   * card be exiled face down); only their faces are not, so a count that left
   * them out would under-report a public fact.
   */
  readonly exileCount: number;
  /**
   * Exile's cards, MINUS any the viewer is not entitled to identify.
   *
   * ⚠️ Exile is the one "public" zone that is not fully public: a card with
   * foretell is exiled FACE DOWN and only its owner may look at it
   * (CR 702.143a, `CardInstance.faceDown`). This list is the masked half — a
   * face-down card of the OPPONENT's is never copied into it, so no consumer
   * holds the secret and none can leak it. See {@link SeatView.exileHiddenCount}
   * for the other half.
   */
  readonly exile: readonly VisibleHandCard[];
  /**
   * How many of this seat's exiled cards are withheld from the viewer. A count
   * and nothing else, deliberately: there is no field here for a name or a card
   * id to travel in, which is what makes the guarantee structural rather than a
   * promise every renderer has to keep.
   */
  readonly exileHiddenCount: number;
  readonly manaPool: Readonly<Record<string, number>>;
  /**
   * The printed SPEND RESTRICTIONS on mana currently floating — "only to cast a
   * creature spell". One entry per restricted parcel, in the order the mana was
   * added, so a seat holding two differently-restricted mana shows both.
   *
   * Public information, exactly like the mana itself: the restriction was printed
   * on a permanent everyone can read, and the whole table watched it be tapped.
   * Shown because a pool reading "3 mana" while only one of them can pay for the
   * spell in hand is otherwise an unexplained refusal.
   */
  readonly restrictedMana: readonly string[];
  readonly hasLost: boolean;
  readonly permanents: readonly BoardPermanent[];
}

/**
 * WHAT COMBAT IS DOING, for whichever board is drawing it.
 *
 * ⚠️ THE DECLARED FLAGS ARE LOAD-BEARING AND WERE MISSING. `BoardScene` advances
 * a creature to the midline (UX-12 / UX-13) only once its step has HAPPENED, and
 * emptiness cannot stand in for that: declaring no attackers is a legal, common
 * choice (`CombatState` in core says the same thing at length). Without these two
 * flags the hotseat board had to reach past this view model into `session.state`
 * to know — which is exactly why the online board, which HAS no session, could
 * never advance anything. Both builders fill them from their own `CombatState`;
 * `maskStateForSeat` already sends combat unredacted, so nothing here asks the
 * server for a fact it was withholding.
 */
export interface BoardCombatView {
  readonly attackers: readonly InstanceId[];
  readonly blocks: readonly { readonly blocker: InstanceId; readonly attacker: InstanceId }[];
  /** Whether the declare-attackers step has happened (NOT "are there any"). */
  readonly attackersDeclared: boolean;
  /** Whether the declare-blockers step has happened (NOT "are there any"). */
  readonly blockersDeclared: boolean;
  /**
   * What each attacker was declared attacking when it is NOT the defending
   * player — a planeswalker or a battle. Absent for the overwhelmingly common
   * case, exactly as core's `CombatState` leaves it absent (UX-14's arcs need it
   * to aim; an attacker with no entry attacks the defending player).
   */
  readonly attackTargets?: Readonly<Record<InstanceId, InstanceId | PlayerId>>;
}

/**
 * THE ONE ADAPTER from core's `CombatState` to the board's combat view.
 *
 * Read by BOTH builders — `buildBoardView` here (hotseat, from the authoritative
 * `GameState`) and `lib/online/board-adapter.ts` (online, from the server's
 * `MaskedGameView`, whose `combat` IS a `CombatState`). It used to be two copies
 * of the same `Object.entries` walk that had already drifted: one of them dropped
 * the declared flags and the attack targets, and that omission is the whole
 * reason the online board could not advance a blocker.
 *
 * Nothing is widened or approximated: a field core does not set is left absent
 * rather than defaulted to a plausible value (rule 2).
 */
export function boardCombatView(combat: CombatState | null): BoardCombatView | null {
  if (combat === null) return null;
  return {
    attackers: [...combat.attackers],
    blocks: Object.entries(combat.blocks).map(([blocker, attacker]) => ({
      blocker: Number(blocker),
      attacker,
    })),
    attackersDeclared: combat.attackersDeclared,
    blockersDeclared: combat.blockersDeclared,
    ...(combat.attackTargets !== undefined ? { attackTargets: combat.attackTargets } : {}),
  };
}

/** The full masked board snapshot for one viewer. */
export interface BoardView {
  readonly viewer: PlayerId;
  readonly turnNumber: number;
  readonly activePlayer: PlayerId;
  readonly priorityPlayer: PlayerId;
  readonly step: string;
  readonly stack: readonly StackView[];
  readonly combat: BoardCombatView | null;
  readonly self: SeatView;
  readonly opponent: SeatView;
  readonly gameOver: boolean;
  readonly winner: PlayerId | null;
}

/** The card-id source (token instances have no pool card id). */
function cardIdOf(inst: CardInstance): string {
  return inst.def.id;
}

function visibleHand(hand: readonly CardInstance[]): VisibleHandCard[] {
  return hand.map((c) => ({
    instanceId: c.instanceId,
    cardId: cardIdOf(c),
    name: c.def.name,
    isLand: isLand(c.def),
  }));
}

/**
 * §3.133 — SPLIT a creature's buff by where it came from, and list its counters.
 *
 * A `+1/+1` counter is PERMANENT and a pump is not, and "is that mine forever or
 * does it wear off at end of turn?" is a decision the player makes every combat.
 * One merged number cannot answer it, so this returns the two halves:
 *  - `counters` — every non-zero counter kind ON the permanent, EXCEPT loyalty
 *    and defense, which already have their own badges on the tile;
 *  - `ptFromEffects` — the part of `ptDelta` that is NOT counters (an anthem, an
 *    until-end-of-turn pump), or null when every point came from counters.
 *
 * ⚠️ SHARED by the hotseat view-model and the ONLINE board adapter on purpose: a
 * clarity fix that reaches only one of the two boards is exactly the drift §3.57
 * warned about. `counterNet` mirrors the engine's own arithmetic (stats.ts):
 * +1/+1 counters minus -1/-1 counters, each worth a point of each stat.
 *
 * Online there is no continuous index, so `ptDelta` is the counters alone and
 * this honestly reports no effect delta rather than inventing one.
 */
export function permanentMarks(
  inst: CardInstance,
  ptDelta: { readonly power: number; readonly toughness: number } | null,
  creature: boolean,
): {
  readonly counters: readonly { readonly kind: string; readonly count: number }[];
  readonly ptFromEffects: { readonly power: number; readonly toughness: number } | null;
} {
  const counterNet = (inst.counters[PLUS_ONE_COUNTER] ?? 0) - (inst.counters[MINUS_ONE_COUNTER] ?? 0);
  const effectPower = (ptDelta?.power ?? 0) - counterNet;
  const effectToughness = (ptDelta?.toughness ?? 0) - counterNet;
  return {
    counters: Object.entries(inst.counters)
      .filter(([kind, count]) => count !== 0 && kind !== LOYALTY_COUNTER && kind !== DEFENSE_COUNTER)
      .map(([kind, count]) => ({ kind, count })),
    ptFromEffects:
      creature && (effectPower !== 0 || effectToughness !== 0)
        ? { power: effectPower, toughness: effectToughness }
        : null,
  };
}

/**
 * THE LAZY PROVENANCE READER (§3.143 / UX-17), memoised per `buildBoardView` pass.
 *
 * `explainCharacteristics` walks `state.continuous`, the attachments and the
 * counters for ONE permanent. Built EAGERLY — which is how §3.143 wave 1 shipped
 * it — that is one such walk per permanent per pass, twenty on a real board, for
 * a breakdown that only the tile the player is actually looking at ever reads.
 * The overhaul's own §2.1 asked for the opposite in as many words: *"Attribution
 * is built only when asked for (a separate entry point / lazy field), never on
 * every `effectivePower` read."*
 *
 * A GETTER rather than a method, so every consumer keeps reading
 * `perm.explanation` and no call site had to learn a new shape. The cache is per
 * pass, so two reads of one tile in one frame walk once and a new state never
 * serves a stale breakdown.
 *
 * ⚠️ A getter is only safe because `BoardView` is React render input and is
 * never serialized or structured-cloned (either would evaluate every one of
 * them, which is precisely the eager cost this removes). If that ever changes,
 * this has to change with it.
 */
function explainerFor(
  state: GameState,
  cont: ContinuousIndex,
  cache: Map<InstanceId, CharacteristicExplanation | undefined>,
): (instanceId: InstanceId) => CharacteristicExplanation | undefined {
  return (instanceId) => {
    // `has`, not a truthy check: `undefined` is a real answer (an instance core
    // cannot find) and must not be recomputed on every read.
    if (!cache.has(instanceId)) cache.set(instanceId, explainCharacteristics(state, instanceId, cont));
    return cache.get(instanceId);
  };
}

/**
 * Core's characteristic breakdown for an instance the board draws FULL SIZE
 * OUTSIDE the battlefield — the card a target prompt is about to cast, an
 * opponent's spell held on the stack before it resolves (§3.143 / UX-8 + UX-17).
 *
 * The ONE producer for those faces, so a prompt and a tile cannot explain one
 * card two different ways (rule 12). `null`/`undefined` in gives `undefined`
 * out, and so does an id core cannot find (a token that has ceased to exist, an
 * id from a stale frame) — `CardFace` renders those as the plain printed card.
 *
 * ⚠️ HIDDEN INFORMATION IS THE CALLER'S PROBLEM. `explainCharacteristics` reads
 * every zone including both hands, so this must only ever be called with an
 * instance the viewer may already see: their own hand card, or a public object.
 */
export function explainForFace(
  state: GameState,
  instanceId: InstanceId | null | undefined,
): CharacteristicExplanation | undefined {
  if (instanceId === null || instanceId === undefined) return undefined;
  return explainCharacteristics(state, instanceId);
}

function boardPermanent(
  state: GameState,
  inst: CardInstance,
  cont: ContinuousIndex,
  explain: (instanceId: InstanceId) => CharacteristicExplanation | undefined,
): BoardPermanent {
  const mod = cont.get(inst.instanceId) ?? NO_MOD;
  const creature = isCreature(inst.def);
  const power = creature ? effectivePower(inst, mod) : 0;
  const toughness = creature ? effectiveToughness(inst, mod) : 0;
  const printedPower = creature ? (inst.def.power ?? 0) : 0;
  const printedToughness = creature ? (inst.def.toughness ?? 0) : 0;
  const ptDelta =
    creature && (power !== printedPower || toughness !== printedToughness)
      ? { power: power - printedPower, toughness: toughness - printedToughness }
      : null;
  const { counters, ptFromEffects } = permanentMarks(inst, ptDelta, creature);
  const combat = state.combat;
  const attacking = combat !== null && combat.attackers.includes(inst.instanceId);
  const blocking = combat !== null ? (combat.blocks[inst.instanceId] ?? null) : null;
  return {
    instanceId: inst.instanceId,
    cardId: cardIdOf(inst),
    name: inst.def.name,
    controller: inst.controller,
    isCreature: creature,
    isLand: isLand(inst.def),
    isPlaneswalker: isPlaneswalker(inst.def),
    // A walker's loyalty LIVES in its counters (engine invariant), so this is the
    // authoritative current value, not the printed one.
    loyalty: isPlaneswalker(inst.def) ? loyaltyOf(inst) : 0,
    isBattle: isBattle(inst.def),
    // Same engine invariant as loyalty: a battle's defense LIVES in its counters,
    // so this is the authoritative current value rather than the printed one.
    defense: isBattle(inst.def) ? defenseOf(inst) : 0,
    protector: isBattle(inst.def) ? protectorOf(inst) : null,
    // The SHARED index is handed straight through, so the whole board costs one
    // `indexContinuous` rather than one per permanent (lane E's contract) — and
    // the walk behind it happens only for a tile somebody reads ({@link explainerFor}).
    get explanation(): CharacteristicExplanation | undefined {
      return explain(inst.instanceId);
    },
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    power,
    toughness,
    printedPower,
    printedToughness,
    ptDelta,
    ptFromEffects,
    counters,
    damageMarked: inst.damageMarked,
    keywords: effectiveKeywords(inst, mod),
    // Which mana this source could still make. Reads normalised MODES, so a modal
    // source (any-colour creature, dual land) lists each colour it could choose —
    // and reading the legacy `produces` field alone would show nothing for them.
    producesIfTapped: inst.tapped ? [] : manaColorsOffered(inst.def),
    attacking,
    blocking,
  };
}

/**
 * Build the masked seat view for `seat`, revealing the hand only if `reveal`.
 *
 * ⚠️ `cont` is passed IN, not built here. It was built once per SEAT, which is
 * twice per frame for a two-player board, and it walks the whole battlefield —
 * and now every permanent's `explainCharacteristics` reads the same index, so
 * building it per seat would also mean two seats' explanations came from two
 * different index objects for one state. One per render pass, built by
 * {@link buildBoardView}.
 */
function seatView(
  state: GameState,
  seat: PlayerId,
  name: string,
  reveal: boolean,
  cont: ContinuousIndex,
  explain: (instanceId: InstanceId) => CharacteristicExplanation | undefined,
): SeatView {
  const p = state.players[seat];
  const permanents = state.battlefield
    .filter((c) => c.controller === seat)
    .map((c) => boardPermanent(state, c, cont, explain));
  return {
    id: seat,
    name,
    life: p.life,
    poison: poisonOf(p),
    handCount: p.hand.length,
    hand: reveal ? visibleHand(p.hand) : null,
    libraryCount: p.library.length,
    graveyardCount: p.graveyard.length,
    graveyard: visibleHand(p.graveyard),
    exileCount: p.exile.length,
    // THE MASK, and it is the same rule the online seam already applies
    // (`maskStateForSeat`, §3.112): a face-down exiled card of a seat the viewer
    // is not is withheld — identity never copied, only counted. `reveal` is the
    // viewer's own seat, and your own foretold card is yours to look at.
    exile: visibleHand(p.exile.filter((c) => reveal || c.faceDown !== true)),
    exileHiddenCount: reveal ? 0 : p.exile.filter((c) => c.faceDown === true).length,
    manaPool: poolColorCounts(p.manaPool),
    restrictedMana: poolRestrictionLabels(p.manaPool),
    hasLost: p.hasLost,
    permanents,
  };
}

/**
 * Any instance the board may need to NAME or draw a FACE for: every public zone
 * plus the stack. Used only to resolve a stack object's targets, which are bare
 * ids — so it walks public information only and never reaches into a hand.
 */
function instanceById(state: GameState, id: InstanceId): CardInstance | undefined {
  for (const perm of state.battlefield) if (perm.instanceId === id) return perm;
  for (const pid of ['A', 'B'] as const) {
    const player = state.players[pid];
    for (const zone of [player.graveyard, player.exile]) {
      const hit = zone.find((c) => c.instanceId === id);
      if (hit) return hit;
    }
  }
  for (const obj of state.stack) {
    if (obj.kind === 'spell' && obj.instanceId === id) return obj.card;
  }
  return undefined;
}

/**
 * The stack, as facts. DELEGATED to lane A's `stackEntries` — the ONE producer —
 * so the panel gets a card id per row and can draw the real face (UX-1). It also
 * distinguishes an ACTIVATED ability from a TRIGGERED one, which the hand-rolled
 * version here collapsed into "Trigger" even though core has told them apart
 * since `TriggeredStackObject.origin` was added.
 *
 * ⚠️ The reversal (engine order is bottom-first; the panel reads top-first)
 * lives in `stackEntries` now. Reversing here as well would put the stack back
 * the wrong way up.
 */
function stackView(state: GameState): readonly StackView[] {
  return stackEntries(state.stack, {
    nameOf: (id) => instanceById(state, id)?.def.name ?? `#${id}`,
    faceOf: (id) => instanceById(state, id)?.def.id ?? null,
  });
}

/**
 * Build the masked board view for `viewer`. The viewer's own hand is revealed; the
 * opponent's hand is masked (hand === null, only `handCount`). This is the function
 * the hidden-info test asserts against.
 */
export function buildBoardView(
  state: GameState,
  viewer: PlayerId,
  names: Readonly<Record<PlayerId, string>>,
): BoardView {
  const opponentId: PlayerId = viewer === 'A' ? 'B' : 'A';
  // ONE index for the whole pass — both seats' permanents and every
  // `explainCharacteristics` read it (see `seatView`).
  const cont = indexContinuous(state);
  // ONE provenance cache for the whole pass, read through both seats' tiles.
  const explain = explainerFor(state, cont, new Map());
  return {
    viewer,
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    stack: stackView(state),
    combat: boardCombatView(state.combat),
    self: seatView(state, viewer, names[viewer], true, cont, explain),
    opponent: seatView(state, opponentId, names[opponentId], false, cont, explain),
    gameOver: state.gameOver,
    winner: state.winner,
  };
}
