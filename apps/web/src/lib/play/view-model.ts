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
  type CardInstance,
  type ContinuousIndex,
  type GameState,
  type InstanceId,
  type KeywordFlags,
  type ManaPool,
  type PlayerId,
  type StackObject,
  poisonOf,
} from '@jonny-boi/core';

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

/** A hand card the viewer is allowed to see (their own hand). */
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
   * The PRINTED power/toughness, so the board can show the difference. Bug
   * report 20260901_204957: a 1/2 Monastery Swiftspear killed a 0/2 because a
   * prowess pump had made it a 2/3 — correctly — and nothing on screen said
   * so. `ptDelta` is the visible answer: non-null whenever the effective stats
   * differ from the printed ones (a pump, an anthem, a +1/+1 counter), with the
   * signed differences a badge can print as "+1/+1". Zero for non-creatures.
   */
  readonly printedPower: number;
  readonly printedToughness: number;
  readonly ptDelta: { readonly power: number; readonly toughness: number } | null;
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

/** A stack object rendered for the board. */
export interface StackView {
  readonly instanceId: InstanceId;
  readonly kind: 'spell' | 'trigger';
  readonly name: string;
  readonly controller: PlayerId;
  readonly targets: readonly (InstanceId | PlayerId)[];
}

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
  readonly exileCount: number;
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

/** The full masked board snapshot for one viewer. */
export interface BoardView {
  readonly viewer: PlayerId;
  readonly turnNumber: number;
  readonly activePlayer: PlayerId;
  readonly priorityPlayer: PlayerId;
  readonly step: string;
  readonly stack: readonly StackView[];
  readonly combat: {
    readonly attackers: readonly InstanceId[];
    readonly blocks: readonly { readonly blocker: InstanceId; readonly attacker: InstanceId }[];
  } | null;
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

function boardPermanent(state: GameState, inst: CardInstance, cont: ContinuousIndex): BoardPermanent {
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
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    power,
    toughness,
    printedPower,
    printedToughness,
    ptDelta,
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

/** Build the masked seat view for `seat`, revealing the hand only if `reveal`. */
function seatView(state: GameState, seat: PlayerId, name: string, reveal: boolean): SeatView {
  const p = state.players[seat];
  // The continuous index is built ONCE per seat view rather than once per
  // permanent: it walks the whole battlefield, and a crowded board of twenty
  // permanents was rebuilding it twenty times per frame.
  const cont = indexContinuous(state);
  const permanents = state.battlefield
    .filter((c) => c.controller === seat)
    .map((c) => boardPermanent(state, c, cont));
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
    manaPool: poolColorCounts(p.manaPool),
    restrictedMana: poolRestrictionLabels(p.manaPool),
    hasLost: p.hasLost,
    permanents,
  };
}

function stackView(stack: readonly StackObject[]): StackView[] {
  // Render top-of-stack first (resolves first) so the UI reads top-down.
  return [...stack].reverse().map((obj) => {
    if (obj.kind === 'spell') {
      return {
        instanceId: obj.instanceId,
        kind: 'spell' as const,
        name: obj.card.def.name,
        controller: obj.controller,
        targets: obj.targets,
      };
    }
    return {
      instanceId: obj.instanceId,
      kind: 'trigger' as const,
      name: obj.label,
      controller: obj.controller,
      targets: obj.targets,
    };
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
  const combat = state.combat
    ? {
        attackers: [...state.combat.attackers],
        blocks: Object.entries(state.combat.blocks).map(([blocker, attacker]) => ({
          blocker: Number(blocker),
          attacker,
        })),
      }
    : null;
  return {
    viewer,
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    step: state.step,
    stack: stackView(state.stack),
    combat,
    self: seatView(state, viewer, names[viewer], true),
    opponent: seatView(state, opponentId, names[opponentId], false),
    gameOver: state.gameOver,
    winner: state.winner,
  };
}
