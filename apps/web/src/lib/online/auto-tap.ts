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
  phyrexianLifeOptions,
  planManaPayment,
  tapActionFor,
  SPARE_USEFUL_MANA_SOURCES,
  type CardDefinition,
  type CardInstance,
  type CastZone,
  type GameAction,
  type InstanceId,
  type ManaCost,
  type ManaPlanView,
  type ManaTapPlan,
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

/** The reading that pays a cost entirely in mana — every cast bar §3.143's few. */
const ALL_MANA_READING = 0;

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

/** A funded cast: the reading it pays, and the taps that pay for it. */
interface FundedCast {
  /** Life toward the cost's Phyrexian symbols — {@link ALL_MANA_READING} for most casts. */
  readonly phyrexianLife: number;
  /** Empty when the floating pool already pays; the server then offers the cast itself. */
  readonly taps: readonly ManaTapPlan[];
}

/**
 * The CHEAPEST reading of `cost` this board can fund, and the taps that fund it
 * — `null` when no reading is fundable at all.
 *
 * THE ONE FUNNEL for "can this seat pay for that?", shared by the sequence
 * builder and both castable-with-taps sets, so an affordance can never light up
 * a card the sequence then refuses to build.
 *
 * CHEAPEST — the LEAST life — is the rule, and it is a deliberate one. §3.143
 * makes a Phyrexian cost several offers ("{1}{B}{B}", "{1}{B} and 2 life",
 * "{1} and 4 life"), the hotseat puts all of them on a menu, and this seat has
 * no menu to put them on: it holds a redacted view and every tap is a server
 * round trip (see the note at the foot of this file). Life is not a resource to
 * spend on a player's behalf, so the seat takes the reading that spends the
 * least of it and only ever reaches a life reading when no all-mana one exists —
 * which is the difference between the mechanic working online and the card being
 * uncastable there. `phyrexianLifeOptions` is ascending, so "first fundable" IS
 * "cheapest", and it returns `[0]` for every cost with no Phyrexian symbol,
 * where every line here is the code that was here before.
 *
 * A view with no `life` (the field is optional on `ManaPlanView`) yields the
 * all-mana reading alone — honest degradation, never a guess at a life total.
 */
function fundCheapestReading(
  view: ManaPlanView,
  player: PlayerId,
  cost: ManaCost | undefined,
  def: CardDefinition,
  legalActions: readonly GameAction[],
): FundedCast | null {
  if (!cost) return { phyrexianLife: ALL_MANA_READING, taps: [] };
  const life = view.players[player].life ?? ALL_MANA_READING;
  for (const phyrexianLife of phyrexianLifeOptions(cost, life)) {
    const taps = planManaPayment(
      view,
      player,
      cost,
      legalActions,
      def,
      'cast',
      HUMAN_MANA_PREFERENCE,
      phyrexianLife,
    );
    if (taps) return { phyrexianLife, taps };
  }
  return null;
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
 *
 * The cast names the READING the taps were planned for (§3.143). Both come from
 * one call to {@link fundCheapestReading}, so the sequence cannot tap for
 * "{1}{B}{B}" and then ask the server for "{1} and 4 life".
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
  const funded = fundCheapestReading(view, player, cost, card.def, legalActions);
  if (!funded) return null;

  // Built by core's own action builder, not rebuilt from `{instanceId, mode}`:
  // a plan entry can also name the permanent that pays the source's ADDITIONAL
  // cost (Springleaf Drum, Phyrexian Tower), and a tap that drops it is refused
  // by the server that offered it.
  const actions: GameAction[] = funded.taps.map((tap) => tapActionFor(player, tap));
  actions.push({
    kind: 'castSpell',
    player,
    instanceId: card.instanceId,
    targets: targets.length > 0 ? [...targets] : undefined,
    ...(fromZone === 'graveyard' ? { fromZone: 'graveyard' as const } : {}),
    // Written only when it is not the default, so every cast that pays no life
    // is the action object the server has always been sent.
    ...(funded.phyrexianLife === ALL_MANA_READING ? {} : { phyrexianLife: funded.phyrexianLife }),
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
 *
 * Asked through {@link fundCheapestReading}, the same funnel {@link castSequence}
 * builds from, so "this card glows" and "clicking it produces a sequence" are one
 * answer rather than two that can drift.
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
    if (fundCheapestReading(view, player, cost, card.def, legalActions)) out.add(card.instanceId);
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
    if (fundCheapestReading(view, player, cost, card.def, legalActions)) out.add(card.instanceId);
  }
  return out;
}

/**
 * 📌 THE ONLINE MANA PICKER IS NOT BUILT (§3.60), deliberately and honestly.
 *
 * This seat gets the half that needed no UI — every plan above is made under
 * {@link HUMAN_MANA_PREFERENCE}, so an online player's auto-tap spares the mana
 * elf exactly as the hotseat's does. The PICKER is hotseat-only: it wants a
 * private working session to fold taps into and discard on cancel, and this seat
 * has no session — it holds a redacted view and every tap is a server round
 * trip, so cancelling means un-tapping through the server rather than dropping
 * an object. That is a different mechanism, not a re-render of this one.
 *
 * When it is built, the gate is core's `manaPaymentChoiceExists` called with
 * `HUMAN_MANA_PREFERENCE` — the same predicate `GameSession.manaChoiceForCast`
 * asks — so the two seats cannot disagree about when a decision exists. A
 * wrapper for it is NOT parked here in the meantime: an exported helper with no
 * caller is dead code wearing a green checkmark.
 *
 * 📌 NEITHER IS THE ONLINE PHYREXIAN READING PICKER (§3.143), and for the same
 * reason: it is a menu, and a menu is the thing this seat does not have.
 *
 * What it costs today is one option, not correctness. A Phyrexian spell IS
 * castable online — {@link fundCheapestReading} takes the cheapest reading the
 * board can fund, and the cast action names it — but a player who wants to pay
 * MORE life than they have to, to keep a land up for a trick, cannot say so
 * here. The hotseat can (`GameSession.castOptions` offers one option per
 * fundable amount and the board's "how do you want to play this?" menu lists
 * them by price).
 *
 * When it is built, it is the SAME menu, fed from `phyrexianLifeOptions` and
 * `planManaPayment`'s `lifeSpend` — both already threaded through this module —
 * and the sequence stops choosing for the player. Until then this file makes the
 * one choice it can defend: the least life.
 */
