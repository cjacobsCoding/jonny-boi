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
  manaPaymentChoiceExists,
  planManaPayment,
  SPARE_USEFUL_MANA_SOURCES,
  type CardInstance,
  type CastZone,
  type GameAction,
  type InstanceId,
  type ManaCost,
  type ManaPlanView,
  type PlayerId,
} from '@jonny-boi/core';

/**
 * WHICH source the online seat spends when several could — the same §3.60 policy
 * the hotseat uses (`lib/play/session.ts`), because it is the same human making
 * the same decision through a different transport. A seat that auto-tapped its
 * mana elf online and its Forest at the table would be one client contradicting
 * the other.
 */
const HUMAN_MANA_PREFERENCE = SPARE_USEFUL_MANA_SOURCES;

/**
 * The cost this cast pays: the printed cost from hand, the flashback cost from
 * the graveyard (the engine's own rule at `applyCastSpell` — the two must agree
 * or the client plans the wrong taps). `undefined` for a graveyard cast of a
 * card with no flashback: no legal cast exists, so no sequence should either.
 */
function castCost(card: CardInstance, fromZone: CastZone): ManaCost | undefined | null {
  if (fromZone === 'graveyard') return card.def.flashback ?? null;
  return card.def.cost;
}

/**
 * The ordered actions that pay for and then cast `card`, or `null` when the board
 * cannot fund it. An empty tap list is normal — it means the pool already pays, in
 * which case the server has already offered the cast directly. `fromZone`
 * defaults to `'hand'`; pass `'graveyard'` for a flashback cast (the flashback
 * cost is planned for, and the cast action carries the zone so the server looks
 * in the right place).
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
  fromZone: CastZone = 'hand',
): GameAction[] | null {
  const cost = castCost(card, fromZone);
  if (cost === null) return null; // graveyard cast of a card with no flashback
  const plan = cost
    ? planManaPayment(
        view,
        player,
        cost,
        legalActions,
        card.def,
        'cast',
        HUMAN_MANA_PREFERENCE,
      )
    : [];
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
    ...(fromZone === 'graveyard' ? { fromZone: 'graveyard' as const } : {}),
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
    if (planManaPayment(view, player, cost, legalActions, card.def, 'cast', HUMAN_MANA_PREFERENCE)) {
      out.add(card.instanceId);
    }
  }
  return out;
}

/**
 * Which cards in the viewer's GRAVEYARD could be flashback-cast if we tapped for
 * them — the graveyard twin of {@link castableWithTaps}, planning the FLASHBACK
 * cost. Unlike the hand helper it also gates on timing (`sorceryWindowOpen`:
 * the viewer is the active player, in a main phase, stack empty), because a
 * flashback card sits in the graveyard for the whole game — without the gate
 * every sorcery there would glow "castable" on the opponent's turn only to be
 * rejected on submit, a dead-end the hand rarely hits.
 */
export function graveyardCastableWithTaps(
  view: ManaPlanView,
  player: PlayerId,
  graveyard: readonly CardInstance[],
  legalActions: readonly GameAction[],
  sorceryWindowOpen: boolean,
): ReadonlySet<InstanceId> {
  const out = new Set<InstanceId>();
  const hasTaps = legalActions.some((a) => a.kind === 'tapForMana' && a.player === player);
  if (!hasTaps) return out;
  for (const card of graveyard) {
    const cost = card.def.flashback;
    if (cost === undefined) continue;
    const instantSpeed = card.def.timing === 'instant' || card.def.types.includes('instant');
    if (!instantSpeed && !sorceryWindowOpen) continue;
    if (planManaPayment(view, player, cost, legalActions, card.def, 'cast', HUMAN_MANA_PREFERENCE)) {
      out.add(card.instanceId);
    }
  }
  return out;
}

/**
 * Is there a GENUINE choice of which sources fund this cast (§3.60) — the gate
 * on offering the ONLINE seat's mana picker, answered by the same core predicate
 * the hotseat asks. `false` for a cast with no cost and for a graveyard cast of
 * a card with no flashback, both of which have no payment to choose about.
 */
export function castManaChoiceExists(
  view: ManaPlanView,
  player: PlayerId,
  card: CardInstance,
  legalActions: readonly GameAction[],
  fromZone: CastZone = 'hand',
): boolean {
  const cost = castCost(card, fromZone);
  if (!cost) return false;
  return manaPaymentChoiceExists(
    view,
    player,
    cost,
    legalActions,
    card.def,
    'cast',
    HUMAN_MANA_PREFERENCE,
  );
}
