/**
 * Auto-tap for the ONLINE seat.
 *
 * The server is authoritative and only ever lists a `castSpell` once the caster's
 * mana pool ALREADY covers the cost. The online board had no way to tap a land —
 * no control, no action, nothing — so a player's pool was permanently empty, no
 * cast was ever offered, and an online game could play lands and attack but could
 * never cast a single spell.
 *
 * The hotseat client solved this with `castWithAutoTap`, but that path owns a full
 * `GameSession` and a real `GameState`, which the online client (correctly) never
 * has — it holds a redacted view. So this plans the same payment against the
 * public information the view DOES carry (battlefield + own pool, enough for
 * core's `ManaPlanView`) and emits the resulting actions for the client to send.
 *
 * Every emitted action is one the server can validate independently: the taps come
 * from its own `legalActions` list, and the cast is submitted only after them.
 * Nothing here bypasses server authority — a rejected step just stops the sequence.
 */
import {
  planManaPayment,
  type CardInstance,
  type GameAction,
  type InstanceId,
  type ManaPlanView,
  type PlayerId,
} from '@jonny-boi/core';

/**
 * The ordered actions that pay for and then cast `card`, or `null` when the board
 * cannot fund it. An empty tap list is normal — it means the pool already pays, in
 * which case the server has already offered the cast directly.
 *
 * Actions must be sent in order; the server applies them sequentially, so each tap
 * is legal when it arrives and the cast is legal once the last one lands.
 */
export function castSequence(
  view: ManaPlanView,
  player: PlayerId,
  card: CardInstance,
  targets: readonly (InstanceId | PlayerId)[],
  legalActions: readonly GameAction[],
): GameAction[] | null {
  const cost = card.def.cost;
  const plan = cost ? planManaPayment(view, player, cost, legalActions) : [];
  if (!plan) return null;

  const actions: GameAction[] = plan.map((tap) => ({
    kind: 'tapForMana',
    player,
    instanceId: tap.instanceId,
    mode: tap.mode,
  }));
  actions.push({
    kind: 'castSpell',
    player,
    instanceId: card.instanceId,
    targets: targets.length > 0 ? [...targets] : undefined,
  });
  return actions;
}

/**
 * Which cards in the viewer's hand could be cast if we tapped for them — the set
 * the board should show as actionable beyond the ones the server already offers.
 *
 * Only reports a card when a funding plan exists AND the server is currently
 * offering at least one tap, which is what tells us the timing window is open at
 * all (the server withholds `tapForMana` when the seat lacks priority).
 */
export function castableWithTaps(
  view: ManaPlanView,
  player: PlayerId,
  hand: readonly CardInstance[],
  legalActions: readonly GameAction[],
): ReadonlySet<InstanceId> {
  const out = new Set<InstanceId>();
  const hasTaps = legalActions.some((a) => a.kind === 'tapForMana' && a.player === player);
  if (!hasTaps) return out;
  for (const card of hand) {
    const cost = card.def.cost;
    if (!cost) continue;
    if (planManaPayment(view, player, cost, legalActions)) out.add(card.instanceId);
  }
  return out;
}
