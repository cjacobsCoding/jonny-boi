/**
 * A CAST PERMISSION THAT BELONGS TO ANOTHER SEAT — the piece Jace, Architect of
 * Thought's −8 was waiting on.
 *
 * "For each player, search that player's library for a nonland card and exile
 * it … You may cast those cards without paying their mana costs." The card
 * exiled from the OPPONENT's library sits in the opponent's exile (this engine
 * models exile per player) and it is Jace's CONTROLLER who may cast it. Every
 * permission before this one was the owner's own — an adventurer, a Siege
 * reward, a foretold or plotted card — so the offer loop walked the asking
 * player's own exile, the cast path looked the card up there, and the removal
 * on cast took it out of there. Three places that agreed only because owner and
 * caster had always been the same player.
 *
 * `CardGrant.castBy` names the caster when it is not the owner;
 * `CastPermission.by` reports it; the offer loop, the cast path and the play
 * path compare THAT to the acting player. The cast itself then works as CR 112.2
 * says: the spell's controller is the player who cast it, so a permanent enters
 * under the caster's control while the card's OWNER is unchanged — an instant
 * or sorcery still goes to its owner's graveyard (CR 608.2n).
 *
 * The controls matter as much as the feature: an owner-only grant (no `castBy`)
 * must be offered to the owner and to NOBODY else, exactly as before, and a
 * seat that is not the permission's must be refused by name even if it names
 * the right card and the right zone.
 */
import { describe, expect, it } from 'vitest';
import {
  addCardGrant,
  applyAction,
  castPermissionFor,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  type CardDefinition,
  type CardInstance,
  type EffectContext,
  type GameAction,
  type GameState,
  type SpellStackObject,
} from './index.js';
import { createEffectRegistry, type EffectRegistry } from './effects.js';
import { creatureDef, deckOf, landDef } from './test-fixtures.js';

const MOUNTAIN = landDef('Mountain', 'R');
/** A {4} 4/4 — expensive on purpose, so a FREE cast is visibly free (the pool stays empty). */
const OGRE = creatureDef('ogre', 4, 4, { cost: { generic: 4 }, name: 'Test Ogre' });
/** A {3} sorcery, to prove the owner's graveyard is where a cast card from another seat ends up. */
const RITE: CardDefinition = {
  id: 'rite',
  name: 'Test Rite',
  types: ['sorcery'],
  timing: 'sorcery',
  cost: { generic: 3 },
  effects: [{ primitive: 'noteResolved' }],
};

function registry(resolved: string[]): EffectRegistry {
  const reg = createEffectRegistry();
  reg.register('noteResolved', (ctx: EffectContext) => {
    resolved.push(ctx.source.def.name);
  });
  return reg;
}

function act(state: GameState, action: GameAction, reg: EffectRegistry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
  return result.state;
}

function rejection(state: GameState, action: GameAction, reg: EffectRegistry): string | undefined {
  const rejected = applyAction(state, action, DEFAULT_RULES, reg).events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

function until(state: GameState, reg: EffectRegistry, done: (s: GameState) => boolean): GameState {
  let s = state;
  for (let guard = 0; guard < 600; guard++) {
    if (done(s)) return s;
    if (s.gameOver) throw new Error('game ended first');
    if (s.pendingChoice) throw new Error(`a question parked the game first: ${s.pendingChoice.prompt}`);
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer }, reg);
  }
  throw new Error(`never reached the condition (turn ${s.turnNumber} ${s.step})`);
}

/** A's precombat main, turn 1, empty stack, both hands emptied — the sorcery-speed window. */
function gameAtMain(reg: EffectRegistry): GameState {
  const { state } = createGame({
    seed: 7,
    startingPlayer: 'A',
    registry: reg,
    decks: { A: deckOf(MOUNTAIN, 40), B: deckOf(MOUNTAIN, 40) },
  });
  const s = until(state, reg, (x) => x.step === 'precombatMain');
  s.players.A.hand = [];
  s.players.B.hand = [];
  return s;
}

/** Put a card of B's into B's exile, as a search-and-exile would leave it. */
function exileForB(state: GameState, def: CardDefinition): CardInstance {
  const card: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: 'B',
    owner: 'B',
    zone: 'exile',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players.B.exile.push(card);
  return card;
}

function grantFreeCast(state: GameState, card: CardInstance, castBy?: 'A' | 'B'): void {
  addCardGrant(
    state,
    {
      targetInstanceId: card.instanceId,
      sourceInstanceId: card.instanceId,
      zone: 'exile',
      duration: 'permanent',
      castFace: 'front',
      castFree: true,
      ...(castBy !== undefined ? { castBy } : {}),
    },
    () => {},
  );
}

function castOffersFor(state: GameState, player: 'A' | 'B'): Extract<GameAction, { kind: 'castSpell' }>[] {
  const s: GameState = { ...state, priorityPlayer: player };
  return generateLegalActions(s).filter(
    (a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell' && a.player === player,
  );
}

describe("a permission that belongs to the OTHER seat (Jace's −8)", () => {
  it('is offered to that seat, and to nobody else — the card sitting in its owner’s exile', () => {
    const reg = registry([]);
    const state = gameAtMain(reg);
    const ogre = exileForB(state, OGRE);
    grantFreeCast(state, ogre, 'A');

    expect(castPermissionFor(state, ogre)?.by, 'the permission names its seat').toBe('A');
    const forA = castOffersFor(state, 'A').filter((a) => a.instanceId === ogre.instanceId);
    expect(forA, 'A is offered the card from B’s exile').toHaveLength(1);
    expect(forA[0]?.fromZone).toBe('exile');
    // B owns the card and holds it in exile, and still may NOT cast it: the
    // permission is A's. Asked as B, in B's own priority window.
    const stateForB = until(state, reg, (x) => x.activePlayer === 'B' && x.priorityPlayer === 'B' && x.step === 'precombatMain');
    expect(castOffersFor(stateForB, 'B').some((a) => a.instanceId === ogre.instanceId), 'B is not offered it').toBe(false);
  });

  it('casts for nothing, enters under the CASTER’s control, and leaves the OWNER’s exile', () => {
    const reg = registry([]);
    let s = gameAtMain(reg);
    const ogre = exileForB(s, OGRE);
    grantFreeCast(s, ogre, 'A');
    // Nothing floating: a {4} creature cast free must not need it.
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    const offer = castOffersFor(s, 'A').find((a) => a.instanceId === ogre.instanceId) as GameAction;
    s = act(s, offer, reg);
    const spell = s.stack[0] as SpellStackObject;
    expect(spell.kind).toBe('spell');
    expect(spell.controller, 'CR 112.2 — the caster controls the spell').toBe('A');
    expect(s.players.B.exile.some((c) => c.instanceId === ogre.instanceId), 'the card left B’s exile').toBe(false);
    expect(s.players.A.exile.some((c) => c.instanceId === ogre.instanceId), '…and was never in A’s').toBe(false);

    s = until(s, reg, (x) => x.battlefield.some((c) => c.instanceId === ogre.instanceId));
    const onBoard = s.battlefield.find((c) => c.instanceId === ogre.instanceId)!;
    expect(onBoard.controller, 'the permanent enters under the caster’s control').toBe('A');
    expect(onBoard.owner, 'ownership does not move').toBe('B');
  });

  it('an instant or sorcery cast this way resolves for the caster and goes to its OWNER’s graveyard', () => {
    const resolved: string[] = [];
    const reg = registry(resolved);
    let s = gameAtMain(reg);
    const rite = exileForB(s, RITE);
    grantFreeCast(s, rite, 'A');
    s.players.A.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

    const offer = castOffersFor(s, 'A').find((a) => a.instanceId === rite.instanceId) as GameAction;
    s = act(s, offer, reg);
    s = until(s, reg, (x) => x.stack.length === 0);
    expect(resolved).toEqual(['Test Rite']);
    expect(s.players.B.graveyard.some((c) => c.instanceId === rite.instanceId), 'CR 608.2n — owner’s graveyard').toBe(true);
    expect(s.players.A.graveyard.some((c) => c.instanceId === rite.instanceId)).toBe(false);
  });

  it('refuses the seat the permission does not belong to, by name', () => {
    const reg = registry([]);
    const s = gameAtMain(reg);
    const ogre = exileForB(s, OGRE);
    grantFreeCast(s, ogre, 'A');
    const sB = until(s, reg, (x) => x.activePlayer === 'B' && x.priorityPlayer === 'B' && x.step === 'precombatMain');
    const reason = rejection(sB, { kind: 'castSpell', player: 'B', instanceId: ogre.instanceId, fromZone: 'exile' }, reg);
    expect(reason).toContain('belongs to another player');
  });
});

describe('the control — an owner-only permission is exactly what it was', () => {
  it('is offered to the owner and not to the other seat', () => {
    const reg = registry([]);
    const state = gameAtMain(reg);
    const ogre = exileForB(state, OGRE);
    grantFreeCast(state, ogre); // no castBy: the owner's own permission, as every grant before this
    expect(castPermissionFor(state, ogre)?.by, 'absent castBy resolves to the owner').toBe('B');
    expect(castOffersFor(state, 'A').some((a) => a.instanceId === ogre.instanceId), 'A must not be offered B’s card').toBe(false);
    const stateForB = until(state, reg, (x) => x.activePlayer === 'B' && x.priorityPlayer === 'B' && x.step === 'precombatMain');
    expect(castOffersFor(stateForB, 'B').some((a) => a.instanceId === ogre.instanceId), 'B is').toBe(true);
  });
});
