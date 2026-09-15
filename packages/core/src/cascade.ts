/**
 * CASCADE (CR 702.85) and RIPPLE (CR 702.60) — the library-pile cast windows
 * (DESIGN §3.113).
 *
 * Both keywords are "when you cast this spell, take cards off the top of your
 * library, cast one of them for nothing, put the rest on the bottom". The
 * whole mechanic is therefore two things this engine already has plus one it
 * did not:
 *
 *  1. a cast trigger (`cast-triggers.ts`) whose body is the cards package's
 *     `cascade` / `ripple` primitive;
 *  2. the FREE CAST as a WINDOW — the madness record with a new `kind`, for the
 *     reason suspend gave (§3.106): "you may cast it" is a decision made at
 *     that moment, and a standing free permission would let a pilot hold the
 *     cascaded card for the perfect turn — a strictly better card than
 *     printed. The offer loop, `dispatchAction` and the pilots already play a
 *     window;
 *  3. the PILE — the cards taken off the library that must go to the bottom
 *     once the window closes, however it closes. That is the one new field
 *     ({@link MadnessWindow.pile}), and the two closers below are the only two
 *     readers of it, so a cast and a decline cannot disagree about what
 *     happens to the cards that were not cast.
 *
 * ## Cascade's pile goes to the bottom in a RANDOM order (702.85a)
 * From the state-carried RNG cursor, exactly as a library shuffle does, so a
 * seeded game replays the same bottom order.
 *
 * ## Ripple's pile goes to the bottom "in any order" (702.60a)
 * The revealed order is kept. "Any order" makes every order legal, and a fixed
 * one is reproducible where a choice would cost a question for a decision
 * that has never decided a game.
 *
 * ## Ripple reveals; this engine EXILES the revealed cards for the window
 * A revealed card stays in the library in paper. The cast path casts from the
 * hand, the graveyard or exile — never from a library — and every seat (the
 * pilots, the hotseat UI, the online client) plays a window through
 * `castSpell fromZone: 'exile'`. So the revealed cards sit face-up in exile
 * while the window stands, and go back to the library's bottom when it closes.
 * Nothing can act while a window is open (`dispatchAction` freezes the game),
 * so no card can read the library's size or contents in between; the only
 * trace is the replay's `zoneChange` pair. That is the honest cost, and it is
 * stated here rather than hidden.
 *
 * ## A chain of same-name casts is a chain of windows
 * Ripple lets its controller cast EVERY revealed card sharing the spell's
 * name. A window holds one card, so after a ripple cast the window RE-OPENS
 * on the next same-name card still in the pile (`settleCastWindowAfterCast`);
 * the pile is bottomed only once no such card remains or the controller
 * declines. Each cast card's own ripple trigger goes on the stack above the
 * rest and resolves only after this window closes — which is the paper
 * ordering too, since a trigger put on the stack during a resolution waits
 * for that resolution to finish.
 */

import type { GameEvent } from './events.js';
import type { CardInstance, GameState, InstanceId, MadnessWindow, PlayerId, SpellStackObject } from './state.js';
import { convertedManaCost } from './mana.js';
import { createRng, shuffle } from './rng.js';
import { moveToZone } from './internal/zones.js';

/**
 * The window kinds whose cast is "without paying its mana cost" — a CLOSED
 * table, read by the cast path, the offer loop and the pilot alike, so a kind
 * added here is free everywhere in the same edit. Madness is absent because
 * madness pays `def.madness`.
 */
const FREE_CAST_WINDOW_KINDS: Readonly<Record<NonNullable<MadnessWindow['kind']>, boolean>> = Object.freeze({
  madness: false,
  suspend: true,
  cascade: true,
  ripple: true,
});

/** Whether the open window's cast pays nothing (suspend, cascade, ripple). */
export function isFreeCastWindow(window: MadnessWindow | null | undefined): boolean {
  if (!window) return false;
  return FREE_CAST_WINDOW_KINDS[window.kind ?? 'madness'];
}

/** Whether `window` is a library-pile window — one that owns cards to bottom. */
function isPileWindow(window: MadnessWindow): boolean {
  return window.kind === 'cascade' || window.kind === 'ripple';
}

/**
 * The mana value of a spell ON THE STACK (CR 202.3b): the printed cost plus
 * the chosen X per {X} symbol. Cascade compares against this, not against the
 * printed number, so a Let-the-Galaxy-Burn cast for X=3 cascades as an 8.
 */
export function stackManaValueOf(spell: SpellStackObject): number {
  const def = spell.card.def;
  const base = def.cost ? convertedManaCost(def.cost) : 0;
  return base + (spell.xValue ?? 0) * (def.xCost ?? 0);
}

/** The spell stack object with this id, or undefined (a countered spell has left). */
export function spellOnStackById(state: GameState, instanceId: InstanceId): SpellStackObject | undefined {
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const object = state.stack[i]!;
    if (object.kind === 'spell' && object.instanceId === instanceId) return object;
  }
  return undefined;
}

/**
 * §3.147 — SAY OUT LOUD that this card came off the top of the library.
 *
 * Cascade exiles face up (CR 702.85a) and ripple literally says "reveal"
 * (CR 702.60a), so every card either keyword takes off the library is PUBLIC
 * from that instant. Nothing in the state recorded it: the card sits in exile
 * for the length of ONE resolution and is back in the library, hidden again,
 * before any seat gets priority — so the observation audit, which can only
 * compare settled states, saw a card that had never been on display being named
 * by the window's own `zoneChange` and `pileBottomed` events, and called it a
 * leak. It was right to: 700+ of the soak's 754 violations were this.
 *
 * The remedy is §3.119's, for the same reason — a reveal is the one way a card
 * becomes public WITHOUT a zone change any boundary can observe, so the engine
 * has to say so. `cardRevealed` fires no triggers, so this adds a fact to the
 * log and changes no game outcome.
 */
function revealFromLibrary(player: PlayerId, card: CardInstance, emit: (e: GameEvent) => void): void {
  emit({ type: 'cardRevealed', player, instanceId: card.instanceId, name: card.def.name, fromZone: 'library' });
}

/**
 * **CR 702.85a — the exile half of cascade.** Exile cards from the top of
 * `player`'s library until a nonland card with mana value less than `manaValue`
 * is exiled, then open the window on it. Returns the pile (every card exiled,
 * hit included) so a caller can assert on it.
 *
 * No hit — the library ran out, or every card in it was a land or too big —
 * means nothing to cast: the pile goes straight to the bottom in random order
 * and no window opens (there is nothing to decline).
 *
 * Another window already standing is only reachable from a hand-built state
 * (a window freezes the game until it is answered, so two cascade triggers
 * resolve one after the other); the pile is then bottomed uncast, which plays
 * WEAKER than printed, never stronger.
 */
export function performCascade(
  state: GameState,
  player: PlayerId,
  manaValue: number,
  emit: (e: GameEvent) => void,
): readonly InstanceId[] {
  const library = state.players[player].library;
  const pile: InstanceId[] = [];
  let hit: CardInstance | undefined;
  while (library.length > 0) {
    const top = library[0]!;
    revealFromLibrary(player, top, emit);
    moveToZone(state, top, 'exile', emit);
    pile.push(top.instanceId);
    const def = top.def;
    if (!def.types.includes('land') && (def.cost ? convertedManaCost(def.cost) : 0) < manaValue) {
      hit = top;
      break;
    }
  }
  if (hit === undefined || state.madnessWindow) {
    bottomPile(state, player, pile, true, emit);
    return pile;
  }
  state.madnessWindow = { instanceId: hit.instanceId, controller: player, kind: 'cascade', pile };
  emit({ type: 'cascadeWindowOpened', player, instanceId: hit.instanceId, name: hit.def.name });
  return pile;
}

/**
 * **CR 702.60a — the reveal half of ripple**, after its controller has chosen
 * to reveal. The top `count` cards (all of them, if fewer remain) come off the
 * library into the pile; the window opens on the first card named `name`, and
 * a pile with no such card goes straight back to the bottom in the revealed
 * order. Returns the pile.
 */
export function performRipple(
  state: GameState,
  player: PlayerId,
  name: string,
  count: number,
  emit: (e: GameEvent) => void,
): readonly InstanceId[] {
  const library = state.players[player].library;
  const pile: InstanceId[] = [];
  const revealed = Math.min(Math.max(0, count), library.length);
  for (let i = 0; i < revealed; i++) {
    const top = library[0]!;
    revealFromLibrary(player, top, emit);
    moveToZone(state, top, 'exile', emit);
    pile.push(top.instanceId);
  }
  if (!state.madnessWindow && openRippleWindowOn(state, player, name, pile, emit)) return pile;
  bottomPile(state, player, pile, false, emit);
  return pile;
}

/** Open a ripple window on the first same-name card of `pile` still in exile. */
function openRippleWindowOn(
  state: GameState,
  player: PlayerId,
  name: string,
  pile: readonly InstanceId[],
  emit: (e: GameEvent) => void,
): boolean {
  const exile = state.players[player].exile;
  for (const id of pile) {
    const card = exile.find((c) => c.instanceId === id);
    if (card !== undefined && card.def.name === name) {
      state.madnessWindow = { instanceId: card.instanceId, controller: player, kind: 'ripple', pile };
      emit({ type: 'rippleWindowOpened', player, instanceId: card.instanceId, name });
      return true;
    }
  }
  return false;
}

/**
 * The cast path has just CONSUMED a pile window (the offered card left exile
 * for the stack). Ripple looks for the next same-name card and re-opens on it;
 * otherwise, and for cascade always, the rest of the pile goes to the bottom.
 * A non-pile window (madness, suspend) has nothing to settle.
 */
export function settleCastWindowAfterCast(state: GameState, window: MadnessWindow, emit: (e: GameEvent) => void): void {
  if (!isPileWindow(window)) return;
  const pile = window.pile ?? [];
  if (window.kind === 'ripple') {
    const castCard = spellOnStackById(state, window.instanceId)?.card;
    if (castCard !== undefined && openRippleWindowOn(state, window.controller, castCard.def.name, pile, emit)) return;
  }
  bottomPile(state, window.controller, pile, window.kind === 'cascade', emit);
}

/**
 * The controller PASSED on a pile window — "you may cast it", declined. The
 * whole pile, the offered card included, goes to the bottom. Returns false for
 * a window that is not a pile window, so `declineMadness` can fall through to
 * its own kinds.
 */
export function declinePileWindow(state: GameState, window: MadnessWindow, emit: (e: GameEvent) => void): boolean {
  if (!isPileWindow(window)) return false;
  bottomPile(state, window.controller, window.pile ?? [], window.kind === 'cascade', emit);
  return true;
}

/**
 * Put the cards of `pile` that are still in `player`'s exile on the bottom of
 * their library — in a random order (cascade, from the state RNG) or in the
 * pile's own order (ripple). A card no longer in exile (the one that was cast)
 * is skipped, which is what "that weren't cast" means.
 */
function bottomPile(
  state: GameState,
  player: PlayerId,
  pile: readonly InstanceId[],
  random: boolean,
  emit: (e: GameEvent) => void,
): void {
  const exile = state.players[player].exile;
  const cards: CardInstance[] = [];
  for (const id of pile) {
    const card = exile.find((c) => c.instanceId === id);
    if (card !== undefined) cards.push(card);
  }
  let ordered: readonly CardInstance[] = cards;
  if (random && cards.length > 1) {
    const rng = createRng(state.rngState);
    ordered = shuffle(cards, rng);
    state.rngState = rng.state;
  }
  // `moveToZone` pushes onto the library array, whose top is index 0 — so a
  // push IS the bottom, and the cards land in `ordered`'s order top-down.
  for (const card of ordered) moveToZone(state, card, 'library', emit);
  if (ordered.length > 0) {
    emit({ type: 'pileBottomed', player, instanceIds: ordered.map((c) => c.instanceId), random });
  }
}
