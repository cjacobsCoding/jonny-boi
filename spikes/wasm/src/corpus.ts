/**
 * Capture a corpus of REAL mana-payment inputs off the sim's hot path.
 *
 * Every benchmark below runs on inputs recorded from actual gauntlet games —
 * never synthesised — because the whole question is whether a port helps the
 * distribution of work the product really does. A synthetic corpus of 5-colour
 * boards paying 8-drops would flatter any optimisation; the real distribution is
 * mostly 1–4 basic lands paying a one- or two-pip cost, and that is what has to
 * get faster to matter.
 *
 * The capture mirrors `runMatch`'s loop (ask for legal actions → pilot picks →
 * apply) using the real engine and the real pilot, and at each decision point
 * records, for the priority player, one case per castable card in hand:
 *   - the floating mana pool
 *   - the card's mana cost
 *   - every legal `tapForMana` source available, with each of its production modes
 * which is exactly the input `canPay` and `planManaPayment` receive there.
 *
 * Nothing in `packages/` is touched or wrapped — the loop is re-stated here.
 */

import { loadCardPool, buildRegistry } from '@jonny-boi/cards';
import { createDefaultAiRegistry } from '@jonny-boi/ai';
import type { Pilot } from '@jonny-boi/ai';
import { SAMPLE_DECKS, loadDeck, gameSeedFor } from '@jonny-boi/sim';
import type { LoadedDeck } from '@jonny-boi/sim';
import type { GameAction, GameState, ManaCost, ManaColor, PlayerId } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  createRng,
  DEFAULT_RULES,
  generateLegalActions,
  isLand,
  manaModesOf,
  MANA_COLORS,
} from '@jonny-boi/core';

/** Production of one activation mode, flattened to the canonical colour order. */
export type ModeVector = readonly number[];

/** One recorded hot-path payment question. */
export interface PaymentCase {
  /** Floating pool, in canonical `MANA_COLORS` order. */
  readonly pool: readonly number[];
  /** The cost being paid, as the engine's own plain-data record. */
  readonly cost: ManaCost;
  /**
   * Available sources in the order the engine offered them, each as its list of
   * production modes. Source ORDER and mode ORDER are part of the input: the
   * planner's tie-breaks are resolved by first-seen, so a reimplementation that
   * reorders them is a different function even when it is "equally correct".
   */
  readonly sources: readonly ModeVector[][];
  /** The instance id of each source, so a plan can be reported in engine terms. */
  readonly sourceIds: readonly number[];
}

const EMPTY_MODE: readonly number[] = [0, 0, 0, 0, 0, 0];

function vectorOf(production: Readonly<Partial<Record<ManaColor, number>>>): number[] {
  return MANA_COLORS.map((c) => production[c] ?? 0);
}

/** Record the payment questions visible at one game state for the priority player. */
function casesAt(state: GameState, legal: readonly GameAction[], out: PaymentCase[]): void {
  const me: PlayerId = state.priorityPlayer;
  const player = state.players[me];

  // Sources, in the engine's own offer order, grouped by permanent.
  const sourceIds: number[] = [];
  const sources: ModeVector[][] = [];
  const indexById = new Map<number, number>();
  for (const action of legal) {
    if (action.kind !== 'tapForMana' || action.player !== me) continue;
    const perm = state.battlefield.find((c) => c.instanceId === action.instanceId);
    if (!perm) continue;
    const production = manaModesOf(perm.def)[action.mode ?? 0];
    if (!production) continue;
    let idx = indexById.get(action.instanceId);
    if (idx === undefined) {
      idx = sources.length;
      indexById.set(action.instanceId, idx);
      sourceIds.push(action.instanceId);
      sources.push([]);
    }
    (sources[idx] as ModeVector[]).push(vectorOf(production));
  }

  const pool = MANA_COLORS.map((c) => player.manaPool[c]);
  for (const card of player.hand) {
    if (isLand(card.def)) continue;
    const cost = card.def.cost;
    if (!cost) continue;
    out.push({ pool, cost, sources, sourceIds });
  }
  void EMPTY_MODE;
}

export interface CaptureOptions {
  readonly pilotId: string;
  readonly games: number;
  readonly seed: number;
  readonly maxTurns: number;
  readonly maxActions: number;
}

/** Play games with the real engine + pilot and return every payment case seen. */
export function captureCorpus(opts: CaptureOptions): PaymentCase[] {
  const pool = loadCardPool();
  const registry = buildRegistry(pool);
  const ai = createDefaultAiRegistry();
  const pilot: Pilot | undefined = ai.getPilot(opts.pilotId);
  if (!pilot) throw new Error(`no pilot registered under id "${opts.pilotId}"`);

  const decks: LoadedDeck[] = SAMPLE_DECKS.map((d) => loadDeck(d, pool));
  const cases: PaymentCase[] = [];

  for (let g = 0; g < opts.games; g++) {
    // Rotate the pairing so the corpus spans every archetype's mana base, not
    // just one deck's — a mono-colour board and a two-colour board exercise very
    // different amounts of the planner's search.
    const deckA = decks[g % decks.length] as LoadedDeck;
    const deckB = decks[(g * 3 + 1) % decks.length] as LoadedDeck;
    const seed = gameSeedFor(opts.seed, g);
    const rngA = createRng((seed ^ 0x9e3779b9) >>> 0);
    const rngB = createRng((seed ^ 0x85ebca6b) >>> 0);

    let state = createGame({
      seed,
      startingPlayer: 'A',
      config: DEFAULT_RULES,
      registry,
      decks: { A: { cards: deckA.library }, B: { cards: deckB.library } },
    }).state;

    let actions = 0;
    while (!state.gameOver && state.turnNumber <= opts.maxTurns && actions < opts.maxActions) {
      const legal = generateLegalActions(state, DEFAULT_RULES);
      if (legal.length === 0) break;
      casesAt(state, legal, cases);
      const seat = state.priorityPlayer;
      const chosen = pilot.chooseAction({
        view: state,
        legalActions: legal,
        rng: seat === 'A' ? rngA : rngB,
        registry,
        rulesConfig: DEFAULT_RULES,
      });
      state = applyAction(state, chosen, DEFAULT_RULES, registry).state;
      actions++;
    }
  }
  return cases;
}
