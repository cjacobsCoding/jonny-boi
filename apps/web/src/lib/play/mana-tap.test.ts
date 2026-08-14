/**
 * MANUAL mana tapping — the control that lets a hotseat human float mana and, for
 * a MODAL source, say which colour it makes. Without it Birds of Paradise's "any
 * colour" is a decision the player is never allowed to take.
 *
 * These tests read the menu off the engine's real `generateLegalActions`, which is
 * the point: the UI must not have its own opinion about what is tappable (that is
 * how summoning sickness and tapped-ness get out of sync with the rules).
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  createGame,
  poolTotal,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { GameSession } from './session.js';
import { isModalTap, manaTapMenu, tappableIds } from './mana-tap.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
/** A library big enough for the engine's opening draws. */
const LIBRARY_SIZE = 40;

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId, sick = false): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: sick,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

/** A session in A's precombat main with a board we sculpt directly. */
function sculpted(build: (state: GameState) => void): GameSession {
  const forest = card('Forest');
  const created = createGame({
    seed: 42,
    decks: {
      A: { cards: Array.from({ length: LIBRARY_SIZE }, () => forest) },
      B: { cards: Array.from({ length: LIBRARY_SIZE }, () => forest) },
    },
    registry,
  });
  const state = created.state;
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  build(state);
  return GameSession.fromCreated(created, registry, SEAT_NAMES);
}

function menuOf(session: GameSession) {
  return manaTapMenu(session.state, session.legalActions());
}

describe('manual mana tap menu', () => {
  it('offers a basic land one option, labelled with the colour it makes', () => {
    let id = 0;
    const session = sculpted((s) => {
      id = place(s, card('Forest'), 'A').instanceId;
    });
    const options = menuOf(session).get(id);
    expect(options).toHaveLength(1);
    expect(options![0]!.label).toBe('G');
    expect(isModalTap(options!)).toBe(false);
  });

  it('offers a MODAL source one option per colour, so the player picks', () => {
    let id = 0;
    const session = sculpted((s) => {
      id = place(s, card('Birds of Paradise'), 'A').instanceId;
    });
    const options = menuOf(session).get(id);
    expect(options!.length).toBeGreaterThan(1);
    expect(isModalTap(options!)).toBe(true);
    // Every WUBRG colour is offered, each as its own mode index.
    expect(new Set(options!.map((o) => o.label))).toEqual(new Set(['W', 'U', 'B', 'R', 'G']));
    expect(new Set(options!.map((o) => o.mode)).size).toBe(options!.length);
  });

  it('labels a multi-mana mode by its quantity (Sol Ring adds two colourless)', () => {
    let id = 0;
    const session = sculpted((s) => {
      id = place(s, card('Sol Ring'), 'A').instanceId;
    });
    const options = menuOf(session).get(id);
    expect(options).toHaveLength(1);
    expect(options![0]!.label).toBe('2 C');
    expect(options![0]!.colors).toEqual(['C', 'C']);
  });

  it('tapping a chosen mode really adds THAT colour to the pool', () => {
    let id = 0;
    const session = sculpted((s) => {
      id = place(s, card('Birds of Paradise'), 'A').instanceId;
    });
    const blue = menuOf(session).get(id)!.find((o) => o.label === 'U')!;
    const result = session.tapForMana(blue.instanceId, blue.mode);
    expect(result.rejected).toBeNull();
    const pool = result.session.state.players.A.manaPool;
    expect(pool.U).toBe(1);
    expect(poolTotal(pool)).toBe(1);
  });

  it('never offers a summoning-sick mana creature (the engine decides, not the UI)', () => {
    let id = 0;
    const session = sculpted((s) => {
      id = place(s, card('Birds of Paradise'), 'A', true).instanceId;
    });
    expect(menuOf(session).has(id)).toBe(false);
  });

  it('never offers a permanent that is already tapped', () => {
    let id = 0;
    const session = sculpted((s) => {
      const forest = place(s, card('Forest'), 'A');
      forest.tapped = true;
      id = forest.instanceId;
    });
    expect(menuOf(session).has(id)).toBe(false);
  });

  it('lights up nothing on a seat that does not hold priority', () => {
    let mine = 0;
    let theirs = 0;
    const session = sculpted((s) => {
      mine = place(s, card('Forest'), 'A').instanceId;
      theirs = place(s, card('Forest'), 'B').instanceId;
    });
    const menu = menuOf(session);
    // A holds priority: A's land is tappable, B's is not offered at all.
    expect(tappableIds(menu, session.state, 'A').has(mine)).toBe(true);
    expect(menu.has(theirs)).toBe(false);
    // Viewing as B (whose priority window it is not) lights up nothing.
    expect(tappableIds(menu, session.state, 'B').size).toBe(0);
  });
});
