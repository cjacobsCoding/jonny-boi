/**
 * **Proof of life for the observation seam** — the smallest useful thing a pilot
 * can do with evidence it could not previously see.
 *
 * This is deliberately NOT the opponent belief model of the program brief
 * (§13–17). It builds no distribution, samples no worlds, and changes no
 * decision. It is a tally: *what has the opponent actually shown me this game?*
 * That is the input every one of those later systems consumes, and having it
 * exist, be exercised by real games and be provably free of hidden information
 * is what makes the seam trustworthy enough to build them on.
 *
 * It also demonstrates the two properties the seam is supposed to guarantee, in
 * a form a test can check:
 *   - the tally counts things `chooseAction` alone could never have counted
 *     (the opponent's plays happen while this pilot is not being asked anything);
 *   - the tally starts empty in every game, because its state lives in the
 *     per-game observer the harness creates and discards.
 */

import type { GameAction, InstanceId, ManaColor, PlayerId } from '@jonny-boi/core';
import { MANA_COLORS } from '@jonny-boi/core';
import type { GameObserver, GameStartInfo, Observation } from './observation.js';
import type { DecisionContext, Pilot } from './pilot.js';

/** What one seat has publicly revealed so far in a single game. */
export interface OpponentReveals {
  /** Cards they have drawn. Public knowledge; *which* cards is not. */
  readonly cardsDrawn: number;
  /** Lands they have played. */
  readonly landsPlayed: number;
  /** Spells they have cast (including ones that were countered). */
  readonly spellsCast: number;
  /**
   * Spell names they have cast, with counts — the beginnings of brief §16's
   * "known cards" and §32–33's archetype inference. A cast spell is public the
   * moment it hits the stack, so this is inference-grade evidence rather than a
   * peek.
   */
  readonly spellNames: ReadonlyMap<string, number>;
  /** Mana they have produced, by colour — the raw material for brief §35–37. */
  readonly manaProduced: Readonly<Record<ManaColor, number>>;
  /** Instance ids of their cards that have entered public view at least once. */
  readonly knownInstanceIds: ReadonlySet<InstanceId>;
}

/** A {@link GameObserver} that maintains an {@link OpponentReveals} tally. */
export interface OpponentRevealObserver extends GameObserver {
  /** The seat being watched. */
  readonly opponent: PlayerId;
  /** The tally as it stands right now. Snapshot — safe to read mid-decision. */
  reveals(): OpponentReveals;
}

function emptyManaTally(): Record<ManaColor, number> {
  const tally = {} as Record<ManaColor, number>;
  for (const color of MANA_COLORS) tally[color] = 0;
  return tally;
}

/**
 * Build a fresh reveal tracker for ONE game. Everything it accumulates lives in
 * this closure, so when the harness drops the observer at the end of the game the
 * evidence goes with it — the structural half of the per-game isolation argument
 * described on {@link GameObserver}.
 */
export function createOpponentRevealObserver(info: GameStartInfo): OpponentRevealObserver {
  const opponent = info.opponent;
  let cardsDrawn = 0;
  let landsPlayed = 0;
  let spellsCast = 0;
  const spellNames = new Map<string, number>();
  const manaProduced = emptyManaTally();
  const knownInstanceIds = new Set<InstanceId>();

  return {
    opponent,
    observe(observation: Observation): void {
      switch (observation.type) {
        case 'drawCard':
          if (observation.player === opponent) cardsDrawn++;
          return;
        case 'landPlayed':
          if (observation.player === opponent) {
            landsPlayed++;
            knownInstanceIds.add(observation.instanceId);
          }
          return;
        case 'spellCast':
          if (observation.player === opponent) {
            spellsCast++;
            spellNames.set(observation.name, (spellNames.get(observation.name) ?? 0) + 1);
            knownInstanceIds.add(observation.instanceId);
          }
          return;
        case 'manaAdded':
          if (observation.player === opponent) manaProduced[observation.color] += observation.amount;
          return;
        case 'tokenCreated':
          if (observation.controller === opponent) knownInstanceIds.add(observation.instanceId);
          return;
        default:
          return;
      }
    },
    reveals(): OpponentReveals {
      return { cardsDrawn, landsPlayed, spellsCast, spellNames, manaProduced, knownInstanceIds };
    },
  };
}

/**
 * Wrap any pilot so it watches the opponent, without changing a single decision
 * it makes.
 *
 * The wrapper delegates `chooseAction` straight through, so its play is
 * byte-identical to `base`'s — which is the point: it proves the seam is inert
 * with respect to play, and gives the tests a pilot whose *only* difference from
 * a built-in is that it observes. `onDecision`, when supplied, is handed the
 * live tally at each of this pilot's decisions; that is how a consumer (today, a
 * test; tomorrow, a belief model) reaches the evidence.
 */
export function createRevealTrackingPilot(
  base: Pilot,
  onDecision?: (reveals: OpponentReveals) => void,
): Pilot<OpponentRevealObserver> {
  return {
    id: base.id,
    description: `${base.description} (observing)`,
    createGameObserver(info: GameStartInfo): OpponentRevealObserver {
      return createOpponentRevealObserver(info);
    },
    chooseAction(ctx: DecisionContext<OpponentRevealObserver>): GameAction {
      if (onDecision && ctx.observer) onDecision(ctx.observer.reveals());
      return base.chooseAction(ctx);
    },
  };
}
