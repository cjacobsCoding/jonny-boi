/**
 * Small hand-built card definitions and deck helpers for tests. Not part of the
 * public API surface conceptually, but exported so the package's own test files
 * (and, if useful, downstream test suites) can share minimal fixtures without the
 * real card pool. Pure data + tiny builders.
 */

import type { CardDefinition, KeywordFlags } from './card.js';
import type { DeckList } from './engine.js';
import type { CardInstance, GameState, PlayerId } from './state.js';

/** A basic land that taps for one of a given color. */
export function landDef(id: string, color: 'W' | 'U' | 'B' | 'R' | 'G' | 'C' = 'C'): CardDefinition {
  return { id, name: `${id}`, types: ['land'], produces: [color] };
}

/** A vanilla (or keyword-bearing) creature. */
export function creatureDef(
  id: string,
  power: number,
  toughness: number,
  opts: { cost?: CardDefinition['cost']; keywords?: KeywordFlags; name?: string } = {},
): CardDefinition {
  return {
    id,
    name: opts.name ?? id,
    types: ['creature'],
    power,
    toughness,
    cost: opts.cost ?? { generic: 1 },
    keywords: opts.keywords,
  };
}

/** An instant/sorcery carrying effect refs (primitives are tested via a stub registry). */
export function spellDef(
  id: string,
  timing: 'instant' | 'sorcery',
  effects: CardDefinition['effects'],
  cost?: CardDefinition['cost'],
): CardDefinition {
  return {
    id,
    name: id,
    types: [timing],
    timing,
    cost: cost ?? { generic: 1 },
    effects,
  };
}

/** Build a deck from a flat list of defs (repeats fill out the library). */
export function deck(cards: readonly CardDefinition[]): DeckList {
  return { cards };
}

/** A deck of N copies of one def — handy for "library of lands" fixtures. */
export function deckOf(def: CardDefinition, n: number): DeckList {
  return { cards: Array.from({ length: n }, () => def) };
}

/**
 * A deck of the given key cards padded with filler lands up to `size`, so the
 * opening hand can be drawn without decking. Key cards come first (top of the
 * pre-shuffle list) but shuffling is deterministic per seed regardless.
 */
export function paddedDeck(
  keyCards: readonly CardDefinition[],
  size = 40,
  filler: CardDefinition = landDef('Plains', 'W'),
): DeckList {
  const cards = [...keyCards];
  while (cards.length < size) cards.push(filler);
  return { cards };
}

/**
 * Deterministically place fresh instances of `defs` into a player's hand on an
 * existing game state, returning the created instance ids in order. Mutates the
 * given state directly — intended only for building test positions, where it
 * removes shuffle flakiness ("is the card I need in my opening hand?").
 */
export function giveHand(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  return placeInZone(state, player, 'hand', defs, (inst) => state.players[player].hand.push(inst));
}

/**
 * Deterministically REPLACE a player's library with fresh instances of `defs`, in
 * order — `defs[0]` ends up on top. Mutates the given state directly, like
 * {@link giveHand}: a test that asserts "the card I put back is now on top" needs
 * to know exactly what the library holds, which a shuffle cannot give it.
 */
export function giveLibrary(state: GameState, player: PlayerId, defs: readonly CardDefinition[]): CardInstance[] {
  state.players[player].library = [];
  return placeInZone(state, player, 'library', defs, (inst) => state.players[player].library.push(inst));
}

/** Shared instance-minting for the zone-stuffing test helpers above. */
function placeInZone(
  state: GameState,
  player: PlayerId,
  zone: CardInstance['zone'],
  defs: readonly CardDefinition[],
  place: (inst: CardInstance) => void,
): CardInstance[] {
  const created: CardInstance[] = [];
  for (const def of defs) {
    const inst: CardInstance = {
      instanceId: state.nextInstanceId++,
      def,
      controller: player,
      owner: player,
      zone,
      tapped: false,
      summoningSick: true,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    place(inst);
    created.push(inst);
  }
  return created;
}
