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
  isPlaneswalker,
  loyaltyOf,
  manaColorsOffered,
  NO_MOD,
  type CardInstance,
  type GameState,
  type InstanceId,
  type KeywordFlags,
  type PlayerId,
  type StackObject,
} from '@jonny-boi/core';

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
  readonly tapped: boolean;
  readonly summoningSick: boolean;
  readonly power: number;
  readonly toughness: number;
  readonly damageMarked: number;
  readonly keywords: KeywordFlags;
  /** Mana this source can still produce this turn (empty when not a mana source or tapped). */
  readonly producesIfTapped: readonly string[];
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
  readonly handCount: number;
  /** Present ONLY when this seat is visible to the viewer; null when masked. */
  readonly hand: readonly VisibleHandCard[] | null;
  readonly libraryCount: number;
  readonly graveyardCount: number;
  readonly exileCount: number;
  readonly manaPool: Readonly<Record<string, number>>;
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

function boardPermanent(state: GameState, inst: CardInstance): BoardPermanent {
  const mod = indexContinuous(state).get(inst.instanceId) ?? NO_MOD;
  const creature = isCreature(inst.def);
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
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    power: creature ? effectivePower(inst, mod) : 0,
    toughness: creature ? effectiveToughness(inst, mod) : 0,
    damageMarked: inst.damageMarked,
    keywords: effectiveKeywords(inst, mod),
    // Which mana this source could still make. Reads normalised MODES, so a modal
    // source (any-colour creature, dual land) lists each colour it could choose —
    // and reading the legacy `produces` field alone would show nothing for them.
    producesIfTapped: inst.tapped ? [] : manaColorsOffered(inst.def),
  };
}

/** Build the masked seat view for `seat`, revealing the hand only if `reveal`. */
function seatView(state: GameState, seat: PlayerId, name: string, reveal: boolean): SeatView {
  const p = state.players[seat];
  const permanents = state.battlefield
    .filter((c) => c.controller === seat)
    .map((c) => boardPermanent(state, c));
  return {
    id: seat,
    name,
    life: p.life,
    handCount: p.hand.length,
    hand: reveal ? visibleHand(p.hand) : null,
    libraryCount: p.library.length,
    graveyardCount: p.graveyard.length,
    exileCount: p.exile.length,
    manaPool: { ...p.manaPool },
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
