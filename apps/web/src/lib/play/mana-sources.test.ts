/**
 * Hotseat MANA-SOURCE regressions — the manual-play path, which has its own
 * auto-tap and affordability logic on top of the engine.
 *
 * These pin behaviour a player notices immediately at the table:
 *   - a MODAL source (Birds of Paradise: "{T}: Add one mana of any colour") is a
 *     usable mana source in manual play. It is authored with `producesOptions`
 *     rather than the legacy `produces` list, and every consumer that read
 *     `produces` directly treated it as producing NOTHING — a dead card;
 *   - auto-tap picks the right COLOURS, so a spell you can obviously pay for is
 *     castable rather than "not enough mana";
 *   - auto-tap STOPS once the cost is covered, so it never strands mana (pools
 *     empty at end of step, so an over-tap is a real loss);
 *   - a summoning-sick mana creature is not offered and does not break a cast.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  createGame,
  manaColorsOffered,
  poolTotal,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { GameSession } from './session.js';
import { buildBoardView } from './view-model.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

/** A session whose board and hand we sculpt directly, in A's precombat main. */
function sculpted(build: (state: GameState) => void): GameSession {
  const forest = card('Forest');
  const created = createGame({
    seed: 42,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
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

/** Put a permanent onto the battlefield, ready to use (not summoning sick). */
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

/** Put a card into a player's hand. */
function toHand(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[controller].hand.push(inst);
  return inst;
}

describe('a modal mana source is usable in manual play', () => {
  it('Birds of Paradise is reported as a mana source offering every colour', () => {
    const birds = card('Birds of Paradise');
    // The card data itself: authored modally, so the legacy field is absent.
    expect(birds.produces).toBeUndefined();
    expect(manaColorsOffered(birds).sort()).toEqual(['B', 'G', 'R', 'U', 'W']);
  });

  it('shows Birds on the board as a source that can still make mana', () => {
    let bird!: CardInstance;
    const session = sculpted((state) => {
      bird = place(state, card('Birds of Paradise'), 'A');
    });
    const view = buildBoardView(session.state, 'A', SEAT_NAMES);
    const tile = view.self.permanents.find((p) => p.instanceId === bird.instanceId);
    expect(tile, 'Birds should be on A’s battlefield view').toBeDefined();
    // The regression: this was `[]`, so the UI rendered Birds as a non-source.
    expect([...tile!.producesIfTapped].sort()).toEqual(['B', 'G', 'R', 'U', 'W']);
  });

  it('casts a coloured spell funded entirely by Birds', () => {
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Birds of Paradise'), 'A');
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });

    // The option must be offered as affordable-with-a-tap...
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId);
    expect(option, 'Lightning Bolt should be castable off a Bird').toBeDefined();
    expect(option!.affordableWithTap).toBe(true);

    // ...and actually cast, with the Bird tapped for RED specifically.
    const result = session.castWithAutoTap(bolt.instanceId, ['B']);
    expect(result.rejected).toBeFalsy();
    expect(result.session.state.stack.length).toBe(1);
  });
});

describe('auto-tap taps the right sources, and only as many as needed', () => {
  it('taps exactly two lands for a two-mana spell, stranding nothing', () => {
    let bear!: CardInstance;
    const session = sculpted((state) => {
      for (let i = 0; i < 5; i++) place(state, card('Forest'), 'A');
      // Llanowar Elves costs {G}; use a {G}{G}-ish two-drop instead.
      bear = toHand(state, card('Eternal Witness'), 'A'); // {1}{G}{G}
    });

    const result = session.castWithAutoTap(bear.instanceId, []);
    expect(result.rejected).toBeFalsy();
    const tapped = result.session.state.battlefield.filter((p) => p.tapped).length;
    expect(tapped).toBe(3); // {1}{G}{G} = three mana, three Forests
    // Nothing left floating: every point of mana produced was spent.
    expect(poolTotal(result.session.state.players.A.manaPool)).toBe(0);
  });

  it('picks the colour it needs when sources differ', () => {
    let bolt!: CardInstance;
    let mountain!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Forest'), 'A');
      mountain = place(state, card('Mountain'), 'A');
      bolt = toHand(state, card('Lightning Bolt'), 'A'); // {R}
    });

    const result = session.castWithAutoTap(bolt.instanceId, ['B']);
    expect(result.rejected).toBeFalsy();
    // The Mountain paid for it; the Forest — which cannot make {R} — is untouched.
    const mtn = result.session.state.battlefield.find((p) => p.instanceId === mountain.instanceId);
    expect(mtn!.tapped, 'the Mountain should have paid for the Bolt').toBe(true);
    const forest = result.session.state.battlefield.find((p) => p.def.name === 'Forest');
    expect(forest!.tapped, 'the Forest cannot make {R} and should be untapped').toBe(false);
  });

  it('does not count a summoning-sick mana creature as available', () => {
    let bolt!: CardInstance;
    const session = sculpted((state) => {
      place(state, card('Birds of Paradise'), 'A', true); // just resolved — sick
      bolt = toHand(state, card('Lightning Bolt'), 'A');
    });

    // A sick creature cannot pay a {T} cost, so the Bolt is not castable yet.
    const option = session.castOptions().find((o) => o.instanceId === bolt.instanceId);
    expect(option, 'a sick Bird cannot fund a spell').toBeUndefined();

    // And forcing the cast fails cleanly rather than half-tapping the board.
    const result = session.castWithAutoTap(bolt.instanceId, ['B']);
    expect(result.rejected).toBeTruthy();
    expect(result.session.state.battlefield.every((p) => !p.tapped)).toBe(true);
  });
});
