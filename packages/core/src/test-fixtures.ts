/**
 * Small hand-built card definitions and deck helpers for tests. Not part of the
 * public API surface conceptually, but exported so the package's own test files
 * (and, if useful, downstream test suites) can share minimal fixtures without the
 * real card pool. Pure data + tiny builders.
 */

import type { CardDefinition, KeywordFlags } from './card.js';
import type { DeckList } from './engine.js';
import { applyAction, createGame, generateLegalActions } from './engine.js';
import type { GameAction } from './actions.js';
import type { GameEvent } from './events.js';
import type { RulesConfig } from './config.js';
import { DEFAULT_RULES } from './config.js';
import { createRng } from './rng.js';
import { serializeState } from './serialize.js';
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

// --- deterministic self-play (benchmarks + behaviour-lock tests) -----------------

/**
 * A whole game played by a fixed, seeded action-picker, reduced to a value that
 * changes if ANY engine behaviour changes.
 *
 * The digest is the acceptance test for optimization work: a pure speedup must
 * reproduce the same winner, the same turn/action counts, the same event log and
 * the same final board, byte for byte. Counting is not enough — two engines can
 * agree on "A won in 14 turns" while disagreeing about everything in between —
 * so the log and the serialized final state are hashed in full.
 */
export interface SelfPlayResult {
  readonly seed: number;
  readonly winner: PlayerId | null;
  readonly gameOver: boolean;
  readonly turns: number;
  readonly actions: number;
  readonly events: number;
  /** Hash of the complete event log, in order. */
  readonly eventDigest: string;
  /** Hash of the serialized final state (board, zones, life, pending choice). */
  readonly stateDigest: string;
}

/** How long a self-play game may run before it is cut off as a draw. */
export const SELF_PLAY_ACTION_CAP = 1500;

/**
 * The seeds the behaviour-lock test pins. Enough games to cover every branch the
 * hot path takes — combat with and without blocks, decking, keyword grants, the
 * action cap — while staying fast enough to run on every `npm test`.
 */
export const SELF_PLAY_LOCK_SEEDS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
];

/**
 * One self-play game reduced to a single comparable line. The lock test compares
 * these strings rather than a structure so a failure prints exactly which field
 * moved (winner? turn count? the log?) instead of an object diff.
 */
export function selfPlayLockLine(result: SelfPlayResult): string {
  return [
    result.seed,
    result.winner ?? '-',
    result.gameOver ? 'over' : 'cut',
    result.turns,
    result.actions,
    result.events,
    result.eventDigest,
    result.stateDigest,
  ].join('|');
}

/**
 * FNV-1a over a string — a tiny, dependency-free, order-sensitive hash. Not
 * cryptographic and not meant to be: it only has to change when the input does.
 */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Play one full game with a seeded uniform action-picker on both seats.
 *
 * Deliberately NOT a smart pilot: the point is to exercise the engine's hot path
 * (clone → legal actions → apply → events) over a long, varied game with no
 * dependency on `@jonny-boi/ai`, which core must not import. Same seed and same
 * decks ⇒ the same game, always.
 */
export function playSelfPlayGame(
  decks: Readonly<Record<PlayerId, DeckList>>,
  seed: number,
  config: RulesConfig = DEFAULT_RULES,
): SelfPlayResult {
  const rng = createRng(seed);
  const created = createGame({ seed, decks, config });
  let state: GameState = created.state;
  const events: GameEvent[] = [...created.events];
  let actions = 0;

  while (!state.gameOver && actions < SELF_PLAY_ACTION_CAP) {
    const legal = generateLegalActions(state, config);
    if (legal.length === 0) break;
    const action = legal[rng.nextInt(legal.length)] as GameAction;
    const result = applyAction(state, action, config);
    state = result.state;
    for (const e of result.events) events.push(e);
    actions += 1;
  }

  return {
    seed,
    winner: state.winner,
    gameOver: state.gameOver,
    turns: state.turnNumber,
    actions,
    events: events.length,
    eventDigest: digest(JSON.stringify(events)),
    stateDigest: digest(JSON.stringify(serializeState(state))),
  };
}

/**
 * A 60-card deck with a realistic land/creature/spell mix, built from the
 * fixtures above so the benchmark and the behaviour-lock test share one board.
 * `variant` shifts the mix so the two seats play different decks.
 */
export function selfPlayDeck(variant: 0 | 1): DeckList {
  const color = variant === 0 ? 'R' : 'G';
  const land = landDef(variant === 0 ? 'Mountain' : 'Forest', color);
  const cards: CardDefinition[] = [];
  for (let i = 0; i < SELF_PLAY_LANDS; i++) cards.push(land);
  for (let i = 0; i < SELF_PLAY_CREATURES; i++) {
    // A curve of small bodies, every fourth one carrying a keyword so combat,
    // the continuous layer and the keyword predicates all stay on the hot path.
    const size = 1 + (i % 3);
    cards.push(
      creatureDef(`${color}-creature-${size}-${i % 4}`, size, size, {
        cost: { generic: size },
        keywords: i % 4 === 0 ? { haste: true } : i % 4 === 1 ? { flying: true } : undefined,
        name: `${color} Creature ${size}`,
      }),
    );
  }
  while (cards.length < SELF_PLAY_DECK_SIZE) {
    cards.push(creatureDef(`${color}-vanilla`, 2, 2, { cost: { generic: 2 }, name: `${color} Vanilla` }));
  }
  return { cards };
}

/** Deck composition for {@link selfPlayDeck} — named, not sprinkled as literals. */
const SELF_PLAY_DECK_SIZE = 60;
const SELF_PLAY_LANDS = 24;
const SELF_PLAY_CREATURES = 28;

/** The two-seat deck pair every self-play benchmark and lock test uses. */
export function selfPlayDecks(): Readonly<Record<PlayerId, DeckList>> {
  return { A: selfPlayDeck(0), B: selfPlayDeck(1) };
}
