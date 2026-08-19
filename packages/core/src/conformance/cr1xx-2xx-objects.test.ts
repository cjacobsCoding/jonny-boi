/**
 * CONFORMANCE — CR 1xx (game concepts) and CR 2xx–3xx (objects, card types).
 *
 * Indexed by RULE, not by feature: every test here names the Comprehensive Rules
 * reference it pins, so a rule nobody's feature happened to need is visibly
 * missing from `rules-manifest.ts` rather than invisibly absent from the suite.
 *
 * What lives here: starting the game (103), ending it (104), mana (106–107),
 * tokens (111), targets (115), priority's owner (116), damage marking (120),
 * counters (122), and the permanent types whose rules the engine implements —
 * summoning sickness (302.6), lands (305), planeswalkers (306).
 */

import { describe, expect } from 'vitest';
import {
  DEFAULT_RULES,
  LOYALTY_COUNTER,
  PLUS_ONE_COUNTER,
  createGame,
  effectivePower,
  effectiveToughness,
  generateLegalActions,
  loyaltyOf,
  poolTotal,
  type CardDefinition,
  type GameState,
} from '../index.js';
import { creatureDef, deckOf, giveHand, landDef } from '../test-fixtures.js';
import {
  act,
  actWithEvents,
  advanceTo,
  assertFileMatchesManifest,
  crTest,
  eventsNamed,
  fillerDeck,
  newGame,
  onBattlefield,
  pass,
  putOnBattlefield,
  registryWith,
  rejectionOf,
} from './harness.js';

const FILE = 'cr1xx-2xx-objects';

const MOUNTAIN = landDef('Mountain', 'R');
const FOREST = landDef('Forest', 'G');

/** A vanilla body used wherever the test only needs "a creature". */
const BEAR = creatureDef('Bear', 2, 2);

/** A creature carrying a {T} ability, so summoning sickness has something to gate. */
const TAPPER: CardDefinition = {
  ...creatureDef('Tapper', 1, 1),
  activated: [{ cost: { tap: true }, effects: [{ primitive: 'noop' }], label: '{T}: do nothing' }],
};

/** A 3-loyalty walker with a single, cheap plus ability. */
const WALKER: CardDefinition = {
  id: 'walker',
  name: 'Test Walker',
  types: ['planeswalker'],
  cost: { generic: 3 },
  loyalty: 3,
  activated: [{ cost: { loyalty: 1 }, timing: 'sorcery', effects: [{ primitive: 'noop' }], label: '+1' }],
};

/** "{X}: deals X damage to the opponent" — the fixture CR 107.3 is measured on. */
const X_BURN: CardDefinition = {
  id: 'x-burn',
  name: 'X Burn',
  types: ['sorcery'],
  xCost: 1,
  effects: [{ primitive: 'xBurn' }],
};

/** The token definition {@link TOKEN_MAKER} creates. */
const SOLDIER_TOKEN = creatureDef('Soldier Token', 1, 1);

/** A sorcery that makes a 1/1 token through `EffectContext.createToken`. */
const TOKEN_MAKER: CardDefinition = {
  id: 'token-maker',
  name: 'Token Maker',
  types: ['sorcery'],
  effects: [{ primitive: 'makeToken' }],
};

/** "Deal 2 damage to each creature" — untargeted, so it marks damage on a board. */
const SWEEP: CardDefinition = {
  id: 'sweep',
  name: 'Sweep',
  types: ['sorcery'],
  effects: [{ primitive: 'markTwoOnCreatures' }],
};

const registry = registryWith({
  noop: () => {},
  xBurn: (ctx) => {
    const amount = ctx.xValue ?? 0;
    const victim = ctx.controller === 'A' ? 'B' : 'A';
    ctx.state.players[victim].life -= amount;
    ctx.emit({ type: 'lifeChanged', player: victim, delta: -amount, to: ctx.state.players[victim].life });
  },
  makeToken: (ctx) => {
    ctx.createToken(SOLDIER_TOKEN, ctx.controller);
  },
  markTwoOnCreatures: (ctx) => {
    for (const perm of ctx.state.battlefield) {
      if (!perm.def.types.includes('creature')) continue;
      perm.damageMarked += 2;
      ctx.emit({ type: 'damageDealt', targetInstanceId: perm.instanceId, amount: 2 });
    }
  },
});

/** A game sitting in A's precombat main with both hands emptied. */
function atMain(seed = 7): GameState {
  const created = createGame({
    seed,
    startingPlayer: 'A',
    registry,
    decks: { A: deckOf(MOUNTAIN, 40), B: deckOf(FOREST, 40) },
  });
  const state = advanceTo(created.state, 'precombatMain', registry);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** Tap every Mountain A controls, so a cast has funds. */
function tapAllLands(state: GameState): GameState {
  let s = state;
  for (const land of state.battlefield.filter((c) => c.controller === 'A' && c.def.types.includes('land'))) {
    s = act(s, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
  }
  return s;
}

/** Both players pass on an empty stack (or to resolve the top of it). */
function bothPass(state: GameState): GameState {
  return pass(pass(state, registry), registry);
}

// --- CR 103: starting a game ------------------------------------------------------

describe('CR 103 — starting the game', () => {
  crTest('103.3', 'each player begins the game at the starting life total', () => {
    const state = newGame();
    expect(state.players.A.life).toBe(DEFAULT_RULES.startingLife);
    expect(state.players.B.life).toBe(DEFAULT_RULES.startingLife);
  });

  crTest('103.5', 'each player draws an opening hand of the configured size', () => {
    const state = newGame();
    expect(state.players.A.hand).toHaveLength(DEFAULT_RULES.startingHandSize);
    expect(state.players.B.hand).toHaveLength(DEFAULT_RULES.startingHandSize);
    // The cards came OUT of the library — an opening hand conjured from nowhere
    // would satisfy the count while breaking card conservation.
    expect(state.players.A.library).toHaveLength(40 - DEFAULT_RULES.startingHandSize);
  });

  crTest('103.7a', 'the player who takes the first turn skips their first draw step', () => {
    const created = createGame({ seed: 3, startingPlayer: 'A', decks: { A: fillerDeck(), B: fillerDeck() } });
    const handAfterSetup = created.state.players.A.hand.length;
    const firstMain = advanceTo(created.state, 'precombatMain');
    expect(firstMain.turnNumber).toBe(1);
    expect(firstMain.players.A.hand).toHaveLength(handAfterSetup);

    // …and the SECOND turn's draw step is a normal one, so this is the first-turn
    // exception rather than a draw step that never works.
    let s = firstMain;
    for (let guard = 0; guard < 200 && s.turnNumber === 1; guard++) s = pass(s);
    const bHandBefore = s.players.B.hand.length;
    const bMain = advanceTo(s, 'precombatMain');
    expect(bMain.activePlayer).toBe('B');
    expect(bMain.players.B.hand.length).toBe(bHandBefore + DEFAULT_RULES.cardsPerDrawStep);
  });
});

// --- CR 104: ending the game ------------------------------------------------------

describe('CR 104 — ending the game', () => {
  crTest('104.2a', 'a player whose only opponent has lost the game wins it', () => {
    const state = newGame();
    // A real loss through the engine's own path, not a hand-set `winner`.
    state.players.B.life = 0;
    const after = pass(state);
    expect(after.players.B.hasLost).toBe(true);
    expect(after.gameOver).toBe(true);
    expect(after.winner).toBe('A');
  });

  crTest('104.1', 'once the game is over no player is offered any action', () => {
    const state = newGame();
    state.players.B.life = -1;
    const after = pass(state);
    expect(after.gameOver).toBe(true);
    expect(generateLegalActions(after)).toEqual([]);
  });
});

// --- CR 106–107: mana ---------------------------------------------------------------

describe('CR 106–107 — mana', () => {
  crTest('106.1', 'activating a mana ability puts that mana into its controller’s pool', () => {
    const state = atMain();
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    const after = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
    expect(after.players.A.manaPool.R).toBe(1);
    expect(poolTotal(after.players.A.manaPool)).toBe(1);
    expect(onBattlefield(after, land.instanceId)?.tapped).toBe(true);
  });

  crTest('106.4', 'unused mana empties from the pool as each step ends', () => {
    const state = atMain();
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    let s = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
    expect(poolTotal(s.players.A.manaPool)).toBe(1);
    s = bothPass(s);
    expect(s.step).not.toBe('precombatMain');
    expect(poolTotal(s.players.A.manaPool)).toBe(0);
  });

  crTest('605.3a', 'a mana ability does not use the stack — the mana is there at once', () => {
    const state = atMain();
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    const after = act(state, { kind: 'tapForMana', player: 'A', instanceId: land.instanceId }, registry);
    expect(after.stack).toHaveLength(0);
    expect(after.priorityPlayer).toBe('A');
  });

  crTest('107.3', 'the value chosen for {X} is the value the spell resolves with', () => {
    const state = atMain();
    for (let i = 0; i < 3; i++) putOnBattlefield(state, 'A', MOUNTAIN);
    const [spell] = giveHand(state, 'A', [X_BURN]);
    let s = tapAllLands(state);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId }, registry);
    const choice = s.pendingChoice;
    expect(choice?.request.kind).toBe('chooseNumber');
    s = act(
      s,
      { kind: 'answerChoice', player: 'A', choiceId: choice!.id, answer: { kind: 'chooseNumber', value: 2 } },
      registry,
    );
    const lifeBefore = s.players.B.life;
    s = bothPass(s);
    expect(s.players.B.life).toBe(lifeBefore - 2);
  });

  crTest('107.3', 'an {X} larger than the board can pay for is never offered and is refused', () => {
    const state = atMain();
    putOnBattlefield(state, 'A', MOUNTAIN);
    const [spell] = giveHand(state, 'A', [X_BURN]);
    let s = tapAllLands(state);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId }, registry);
    const choice = s.pendingChoice;
    expect(choice).toBeTruthy();
    const offered = generateLegalActions(s)
      .filter((a) => a.kind === 'answerChoice')
      .map((a) => (a as { answer: { value?: number } }).answer.value);
    expect(offered).toEqual(expect.arrayContaining([0, 1]));
    expect(offered).not.toContain(2);
    expect(
      rejectionOf(
        s,
        { kind: 'answerChoice', player: 'A', choiceId: choice!.id, answer: { kind: 'chooseNumber', value: 2 } },
        registry,
      ),
    ).toBeTruthy();
  });
});

// --- CR 111: tokens ------------------------------------------------------------------

describe('CR 111 — tokens', () => {
  crTest('111.1', 'a token created by a resolving spell is a permanent on the battlefield', () => {
    const state = atMain();
    const [spell] = giveHand(state, 'A', [TOKEN_MAKER]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId }, registry);
    s = pass(s, registry);
    const resolved = actWithEvents(s, { kind: 'passPriority', player: s.priorityPlayer }, registry);
    expect(eventsNamed(resolved.events, 'tokenCreated')).toHaveLength(1);
    const token = resolved.state.battlefield.find((c) => c.def.id === SOLDIER_TOKEN.id);
    expect(token).toBeTruthy();
    expect(token?.controller).toBe('A');
    // A token is a creature entering the battlefield, so CR 302.6 applies to it too.
    expect(token?.summoningSick).toBe(true);
  });
});

// --- CR 115: targets -------------------------------------------------------------------

describe('CR 115 — targets', () => {
  crTest('115.2b', 'a spell that says "target creature" cannot be cast at a land', () => {
    const state = atMain();
    const land = putOnBattlefield(state, 'A', MOUNTAIN);
    const zap: CardDefinition = {
      id: 'creature-zap',
      name: 'Creature Zap',
      types: ['sorcery'],
      effects: [{ primitive: 'noop', params: { targets: 'creature' } }],
    };
    const [spell] = giveHand(state, 'A', [zap]);
    expect(
      rejectionOf(
        state,
        { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId, targets: [land.instanceId] },
        registry,
      ),
    ).toBeTruthy();
  });

  crTest('115.4', 'a spell with a target restriction is only offered against legal targets', () => {
    const state = atMain();
    const mine = putOnBattlefield(state, 'A', BEAR);
    const theirs = putOnBattlefield(state, 'B', BEAR);
    putOnBattlefield(state, 'A', MOUNTAIN);
    const zap: CardDefinition = {
      id: 'creature-zap-2',
      name: 'Creature Zap',
      types: ['sorcery'],
      effects: [{ primitive: 'noop', params: { targets: 'creature' } }],
    };
    giveHand(state, 'A', [zap]);
    const offeredTargets = generateLegalActions(state)
      .filter((a) => a.kind === 'castSpell')
      .flatMap((a) => [...((a as { targets?: readonly (number | string)[] }).targets ?? [])]);
    expect(new Set(offeredTargets)).toEqual(new Set([mine.instanceId, theirs.instanceId]));
  });
});

// --- CR 116: priority ------------------------------------------------------------------

describe('CR 116 — priority', () => {
  crTest('116.3a', 'the active player receives priority as each step begins', () => {
    const main = advanceTo(newGame(), 'precombatMain');
    expect(main.priorityPlayer).toBe(main.activePlayer);
  });

  crTest('116.4', 'only the player who holds priority may act', () => {
    const state = atMain();
    const land = putOnBattlefield(state, 'B', FOREST);
    expect(state.priorityPlayer).toBe('A');
    expect(rejectionOf(state, { kind: 'tapForMana', player: 'B', instanceId: land.instanceId }, registry)).toMatch(
      /priority/i,
    );
  });

  crTest('117.3d', 'passing priority hands it to the other player without ending the step', () => {
    const after = pass(atMain(), registry);
    expect(after.priorityPlayer).toBe('B');
    expect(after.step).toBe('precombatMain');
  });
});

// --- CR 120 / 122: damage and counters -----------------------------------------------

describe('CR 120 / 122 — damage and counters', () => {
  crTest('120.3', 'non-lethal damage dealt to a creature is MARKED on it, not applied to toughness', () => {
    const state = atMain();
    const bear = putOnBattlefield(state, 'A', creatureDef('Tough Bear', 2, 4));
    const [spell] = giveHand(state, 'A', [SWEEP]);
    let s = act(state, { kind: 'castSpell', player: 'A', instanceId: spell!.instanceId }, registry);
    s = bothPass(s);
    const after = onBattlefield(s, bear.instanceId);
    expect(after?.damageMarked).toBe(2);
    // Its printed toughness is untouched — damage marks, it does not shrink.
    expect(effectiveToughness(after!)).toBe(4);
  });

  crTest('122.1a', '+1/+1 counters raise both power and toughness through the effective accessors', () => {
    const state = atMain();
    const bear = putOnBattlefield(state, 'A', BEAR, { counters: { [PLUS_ONE_COUNTER]: 2 } });
    expect(effectivePower(bear)).toBe(BEAR.power! + 2);
    expect(effectiveToughness(bear)).toBe(BEAR.toughness! + 2);
  });
});

// --- CR 302: creatures ------------------------------------------------------------------

describe('CR 302 — creatures', () => {
  crTest(
    '302.6',
    'a creature’s activated ability with {T} needs it to have been controlled since your turn began',
    () => {
      const state = atMain();
      const fresh = putOnBattlefield(state, 'A', TAPPER, { summoningSick: true });
      expect(
        generateLegalActions(state).some((a) => a.kind === 'activateAbility' && a.instanceId === fresh.instanceId),
      ).toBe(false);
      expect(
        rejectionOf(
          state,
          { kind: 'activateAbility', player: 'A', instanceId: fresh.instanceId, abilityIndex: 0 },
          registry,
        ),
      ).toBeTruthy();
    },
  );

  crTest('302.6', 'summoning sickness wears off as its controller’s next turn begins', () => {
    const state = atMain();
    const fresh = putOnBattlefield(state, 'A', TAPPER, { summoningSick: true });
    let s = state;
    for (let guard = 0; guard < 400 && !(s.turnNumber === 3 && s.step === 'precombatMain'); guard++) {
      s = pass(s, registry);
    }
    expect(s.activePlayer).toBe('A');
    expect(onBattlefield(s, fresh.instanceId)?.summoningSick).toBe(false);
    expect(
      generateLegalActions(s).some((a) => a.kind === 'activateAbility' && a.instanceId === fresh.instanceId),
    ).toBe(true);
  });
});

// --- CR 305: lands ------------------------------------------------------------------------

describe('CR 305 — lands', () => {
  crTest('305.1', 'a land is played, not cast — it never uses the stack', () => {
    const state = atMain();
    const [land, second] = giveHand(state, 'A', [MOUNTAIN, MOUNTAIN]);
    const after = act(state, { kind: 'playLand', player: 'A', instanceId: land!.instanceId }, registry);
    expect(after.stack).toHaveLength(0);
    expect(onBattlefield(after, land!.instanceId)).toBeTruthy();
    expect(rejectionOf(state, { kind: 'castSpell', player: 'A', instanceId: second!.instanceId }, registry)).toMatch(
      /played, not cast/i,
    );
  });

  crTest('305.2', 'a player may play only the configured number of lands each turn', () => {
    const state = atMain();
    const lands = giveHand(state, 'A', [MOUNTAIN, MOUNTAIN]);
    let s = state;
    for (let i = 0; i < DEFAULT_RULES.maxLandsPerTurn; i++) {
      s = act(s, { kind: 'playLand', player: 'A', instanceId: lands[i]!.instanceId }, registry);
    }
    const extra = lands[DEFAULT_RULES.maxLandsPerTurn]!;
    expect(s.players.A.landsPlayedThisTurn).toBe(DEFAULT_RULES.maxLandsPerTurn);
    expect(generateLegalActions(s).some((a) => a.kind === 'playLand')).toBe(false);
    expect(rejectionOf(s, { kind: 'playLand', player: 'A', instanceId: extra.instanceId }, registry)).toBeTruthy();
  });

  crTest('505.6b', 'a land can only be played during your own main phase on an empty stack', () => {
    const state = atMain();
    const [land] = giveHand(state, 'A', [MOUNTAIN]);
    const inCombat = advanceTo(state, 'declareAttackers', registry);
    expect(generateLegalActions(inCombat).some((a) => a.kind === 'playLand')).toBe(false);
    expect(rejectionOf(inCombat, { kind: 'playLand', player: 'A', instanceId: land!.instanceId }, registry)).toBeTruthy();
  });
});

// --- CR 306: planeswalkers -----------------------------------------------------------------

describe('CR 306 — planeswalkers', () => {
  crTest('306.5b', 'a planeswalker enters the battlefield with its printed loyalty in counters', () => {
    const state = atMain();
    for (let i = 0; i < 3; i++) putOnBattlefield(state, 'A', MOUNTAIN);
    const [card] = giveHand(state, 'A', [WALKER]);
    let s = tapAllLands(state);
    s = act(s, { kind: 'castSpell', player: 'A', instanceId: card!.instanceId }, registry);
    s = bothPass(s);
    const walker = onBattlefield(s, card!.instanceId);
    expect(walker?.zone).toBe('battlefield');
    expect(loyaltyOf(walker!)).toBe(WALKER.loyalty);
    expect(walker!.counters[LOYALTY_COUNTER]).toBe(WALKER.loyalty);
  });
});

assertFileMatchesManifest(FILE);
