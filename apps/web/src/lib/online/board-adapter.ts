/**
 * Adapt the server-sent `MaskedGameView` to the SAME render-ready `BoardView` shape
 * the hotseat board components already consume (view-model.ts). This is the thin
 * adapter that lets `SeatPanel`/`StackPanel`/`PlayCard`/`BoardPermanentTile` render an
 * online game UNCHANGED — we do NOT fork the components.
 *
 * Anti-cheat invariant preserved end-to-end: the server already masked the view (the
 * opponent's `hand` is `null` + a `handCount`). We faithfully carry that through —
 * `self.hand` is populated only when the viewer's own `hand` is present, and the
 * opponent's `hand` stays `null`. We never invent opponent card identities.
 *
 * Effective power/toughness/keywords are computed from each instance with `NO_MOD`
 * (base stats + counters): the client doesn't run the engine for online play and
 * lacks the full `GameState` needed for `indexContinuous`, and the server is the
 * authority for the numbers — this is the correct, robust best-effort display.
 */
import {
  effectiveKeywords,
  effectivePower,
  effectiveToughness,
  isCreature,
  isLand,
  isBattle,
  isPlaneswalker,
  defenseOf,
  loyaltyOf,
  protectorOf,
  manaColorsOffered,
  NO_MOD,
  type CardInstance,
  type PlayerId,
  type StackObject,
} from '@jonny-boi/core';
import type { MaskedGameView, PublicPlayerView } from '@jonny-boi/protocol';
import type {
  BoardPermanent,
  BoardView,
  SeatView,
  StackView,
  VisibleHandCard,
} from '../play/view-model.js';
import { poolColorCounts, poolRestrictionLabels } from '../play/view-model.js';

/** The opposite seat. */
function otherSeat(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

function visibleHand(hand: readonly CardInstance[]): VisibleHandCard[] {
  return hand.map((c) => ({
    instanceId: c.instanceId,
    cardId: c.def.id,
    name: c.def.name,
    isLand: isLand(c.def),
  }));
}

/** Build a board permanent from a battlefield instance (no continuous index online). */
function boardPermanent(inst: CardInstance): BoardPermanent {
  const creature = isCreature(inst.def);
  return {
    instanceId: inst.instanceId,
    cardId: inst.def.id,
    name: inst.def.name,
    controller: inst.controller,
    isCreature: creature,
    isLand: isLand(inst.def),
    isPlaneswalker: isPlaneswalker(inst.def),
    // Loyalty is carried in the instance's counters, which the server sends — so
    // the badge is authoritative online too, no engine run needed.
    loyalty: isPlaneswalker(inst.def) ? loyaltyOf(inst) : 0,
    isBattle: isBattle(inst.def),
    // Defense rides the same counters record loyalty does, so it is likewise
    // authoritative online with no engine run needed.
    defense: isBattle(inst.def) ? defenseOf(inst) : 0,
    protector: isBattle(inst.def) ? protectorOf(inst) : null,
    tapped: inst.tapped,
    summoningSick: inst.summoningSick,
    power: creature ? effectivePower(inst, NO_MOD) : 0,
    toughness: creature ? effectiveToughness(inst, NO_MOD) : 0,
    damageMarked: inst.damageMarked,
    keywords: effectiveKeywords(inst, NO_MOD),
    // Normalised modes, not the legacy `produces` list — see the hotseat
    // view-model for why (modal sources would otherwise render as non-sources).
    producesIfTapped: inst.tapped ? [] : manaColorsOffered(inst.def),
  };
}

/** Build one seat's render view from its `PublicPlayerView` + the shared battlefield. */
function seatView(
  player: PublicPlayerView,
  name: string,
  battlefield: readonly CardInstance[],
): SeatView {
  const permanents = battlefield
    .filter((c) => c.controller === player.id)
    .map(boardPermanent);
  return {
    id: player.id,
    name,
    life: player.life,
    poison: player.poison,
    handCount: player.handCount,
    // The server already decided visibility: own hand present, opponent's is null.
    hand: player.hand ? visibleHand(player.hand) : null,
    libraryCount: player.libraryCount,
    graveyardCount: player.graveyard.length,
    // The graveyard is a PUBLIC zone: the server sends its full contents for both
    // seats, so listing the cards here reveals nothing the table can't see.
    graveyard: visibleHand(player.graveyard),
    exileCount: player.exile.length,
    manaPool: poolColorCounts(player.manaPool),
    restrictedMana: poolRestrictionLabels(player.manaPool),
    hasLost: player.hasLost,
    permanents,
  };
}

function stackView(stack: readonly StackObject[]): StackView[] {
  // Top-of-stack first (resolves first), matching the hotseat view-model.
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
 * Convert a server `MaskedGameView` to the hotseat `BoardView`. `names` maps each seat
 * to a display name (from the lobby). The viewer is `view.viewer`; their own hand is
 * revealed (present in the masked view), the opponent's stays hidden.
 */
export function maskedViewToBoardView(
  view: MaskedGameView,
  names: Readonly<Record<PlayerId, string>>,
): BoardView {
  const viewer = view.viewer;
  const oppId = otherSeat(viewer);
  const combat = view.combat
    ? {
        attackers: [...view.combat.attackers],
        blocks: Object.entries(view.combat.blocks).map(([blocker, attacker]) => ({
          blocker: Number(blocker),
          attacker,
        })),
      }
    : null;
  return {
    viewer,
    turnNumber: view.turnNumber,
    activePlayer: view.activePlayer,
    priorityPlayer: view.priorityPlayer,
    step: view.step,
    stack: stackView(view.stack),
    combat,
    self: seatView(view.players[viewer], names[viewer], view.battlefield),
    opponent: seatView(view.players[oppId], names[oppId], view.battlefield),
    gameOver: view.gameOver,
    winner: view.winner,
  };
}
