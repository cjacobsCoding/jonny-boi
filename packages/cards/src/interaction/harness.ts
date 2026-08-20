/**
 * Shared driver for the INTERACTION MATRIX suites (TESTING.md → "The interaction
 * matrix"). One place that knows how to put a real game in a known position, so
 * every pair test in this directory reads as "board, action, assertion".
 *
 * ## Why these helpers exist at all
 * The rule this whole directory is built on: **a cell is only proved by a REAL
 * ENGINE GAME.** This repo has already shipped bugs that a suite of hand-built
 * fixtures was structurally unable to see —
 *   - `addCounters` threw on the shared frozen `NO_COUNTERS` record for the first
 *     counter on any ENGINE-created permanent, and nine green counter tests all
 *     minted their own instances with a fresh `{}`;
 *   - the pilots read `effectivePower(inst)` with no aggregate, which answers 0
 *     for a characteristic-defining creature, in ~40 places.
 * Both are invisible to a test that builds the object it then measures. So
 * {@link resolvePermanent} CASTS the card and lets the engine create the
 * instance, and every board here comes out of `createGame`.
 *
 * Hand-placement into hand / graveyard / library / exile IS provided
 * ({@link place}), because those are inputs to a position rather than the object
 * under test — a card in a graveyard has no derived state to get wrong. Nothing
 * here places a permanent onto the battlefield directly.
 */

import {
  applyAction,
  DEFAULT_RULES,
  createGame,
  generateLegalActions,
  type CardDefinition,
  type ChoiceAnswer,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { compileCard, type CompilableCard, type CompilableCardFace } from '../compile/index.js';
import { buildRegistry } from '../pool.js';
import { CARD_POOL } from '../../data/pool.js';
import { EXPANDED_CARD_POOL } from '../../data/expanded-pool.js';

export type Registry = ReturnType<typeof buildRegistry>;

/** Every card the app ships, curated + expansion, by name. */
const BY_NAME = new Map<string, CardDefinition>(
  [...CARD_POOL, ...EXPANDED_CARD_POOL].map((card) => [card.name, card]),
);

/**
 * A real shipped pool card by printed name. Throws rather than returning
 * undefined: a matrix cell that silently skipped because its card was renamed
 * would be a test that cannot fail, which is this repo's most-recorded defect.
 */
export function poolCard(name: string): CardDefinition {
  const card = BY_NAME.get(name);
  if (!card) throw new Error(`pool has no card named "${name}"`);
  return card;
}

/** Whether the shipped pool prints this card (for a cell that needs a real one). */
export function poolHas(name: string): boolean {
  return BY_NAME.has(name);
}

/**
 * A card definition built from REAL PRINTED TEXT through the REAL compiler.
 *
 * Four of the newest systems (step triggers, split cards, as-enters choices,
 * mandatory additional costs) have NO card in the shipped pool yet, so a matrix
 * cell about them has to author the record. Authoring the *definition* would be
 * authoring the answer; authoring the printed RECORD and putting it through
 * `compileCard` proves the same thing the pool cards prove - that the engine
 * plays what the card says.
 *
 * Throws when the compiler reports `incomplete`, naming the clause: a cell that
 * silently tested a half-compiled card would be a test that cannot fail.
 */
export function compiled(record: CompilableCard): CardDefinition {
  const result = compileCard(record);
  if (result.status !== 'complete') {
    throw new Error(`"${record.name}" did not compile complete: ${JSON.stringify(result.missing)}`);
  }
  return result.definition;
}

/** A printed-card record with this file's defaults - override what matters. */
export function record(over: Partial<CompilableCard> & { name: string }): CompilableCard {
  return {
    id: `matrix:${over.name}`,
    manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    keywords: [],
    ...over,
  };
}

/** One printed FACE of a two-halved card, with the same defaults. */
export function faceRecord(over: Partial<CompilableCardFace> & { name: string }): CompilableCardFace {
  return {
    manaCost: { generic: 1, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
    typeLine: { supertypes: [], types: ['Instant'], subtypes: [] },
    oracleText: '',
    power: null,
    toughness: null,
    ...over,
  };
}

/** Apply an action, failing loudly if the engine rejected it. */
export function act(state: GameState, action: GameAction, reg: Registry): GameState {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected) {
    throw new Error(`engine rejected ${action.kind}: ${(rejected as { reason: string }).reason}`);
  }
  return result.state;
}

/**
 * The reason the engine REJECTED an action, or `undefined` when it accepted it.
 *
 * The counterpart to {@link act}: a matrix cell about something being ILLEGAL is
 * only proved by the engine refusing it, not by a menu that happens not to
 * mention it. Both halves matter - the menu keeps a pilot honest, the rejection
 * keeps a hand-built action honest - and this is the second half.
 */
export function rejectionOf(state: GameState, action: GameAction, reg: Registry): string | undefined {
  const result = applyAction(state, action, DEFAULT_RULES, reg);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  return rejected ? (rejected as { reason: string }).reason : undefined;
}

/** Pass priority for whoever holds it. */
export function pass(state: GameState, reg: Registry): GameState {
  return act(state, { kind: 'passPriority', player: state.priorityPlayer }, reg);
}

/** Answer the parked choice. */
export function answer(state: GameState, reg: Registry, value: ChoiceAnswer): GameState {
  const pending = state.pendingChoice;
  if (!pending) throw new Error('no choice is parked');
  return act(
    state,
    { kind: 'answerChoice', player: pending.chooser, choiceId: pending.id, answer: value },
    reg,
  );
}

/** How many priority passes a resolution may need before the test gives up. */
const SETTLE_PASS_LIMIT = 24;

/**
 * Resolve everything on the stack. Stops at a parked choice so the caller can
 * answer it deliberately — a helper that auto-answered would hide exactly the
 * questions these tests are about.
 */
export function settle(state: GameState, reg: Registry): GameState {
  let next = state;
  for (let i = 0; i < SETTLE_PASS_LIMIT && next.stack.length > 0 && !next.pendingChoice; i++) {
    if (next.gameOver) break;
    next = pass(next, reg);
  }
  return next;
}

/** Mana handed to a player so a cast under test is never gated on lands. */
const FUNDING = 12;

/** Fill a player's mana pool so any cast in these tests can be paid for. */
export function fund(state: GameState, player: PlayerId = 'A'): void {
  state.players[player].manaPool = {
    W: FUNDING,
    U: FUNDING,
    B: FUNDING,
    R: FUNDING,
    G: FUNDING,
    C: FUNDING,
  };
}

/**
 * A real seeded game parked in `active`'s precombat main with both hands emptied
 * — the position every pair test builds from. The hands are cleared (not the
 * libraries) so the only cards in play are the ones a test deliberately puts
 * there, while draws, the turn machine and the stack stay completely real.
 */
export function boardAtMain(
  reg: Registry,
  opts: { readonly active?: PlayerId; readonly seed?: number; readonly deck?: CardDefinition } = {},
): GameState {
  const filler = opts.deck ?? poolCard('Island');
  const created = createGame({
    seed: opts.seed ?? 0x51a7,
    startingPlayer: opts.active ?? 'A',
    registry: reg,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => filler) },
      B: { cards: Array.from({ length: 40 }, () => filler) },
    },
  });
  let state = created.state;
  let guard = 0;
  while (state.step !== 'precombatMain' && !state.gameOver && guard++ < 50) state = pass(state, reg);
  state.players.A.hand = [];
  state.players.B.hand = [];
  return state;
}

/** Put a fresh instance of `def` into a NON-battlefield zone (position input). */
export function place(
  state: GameState,
  player: PlayerId,
  zone: 'hand' | 'graveyard' | 'library' | 'exile',
  def: CardDefinition,
): InstanceId {
  const instanceId = state.nextInstanceId++;
  state.players[player][zone].push({
    instanceId,
    def,
    controller: player,
    owner: player,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  });
  return instanceId;
}

/**
 * Put a fresh instance of `def` on TOP of a player's library. The top is index 0
 * (`drawCard` uses `shift`), which is the opposite end from {@link place}'s push
 * - a test that got this backwards would look at the wrong card and still pass
 * for the wrong reason.
 */
export function putOnTop(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const instanceId = state.nextInstanceId++;
  state.players[player].library.unshift({
    instanceId,
    def,
    controller: player,
    owner: player,
    zone: 'library',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  });
  return instanceId;
}

/** The result of casting a permanent into play: the new board and its instance id. */
export interface Resolved {
  readonly state: GameState;
  readonly id: InstanceId;
}

/**
 * Cast `def` from `controller`'s hand THROUGH THE ENGINE and let it resolve,
 * whatever zone it ends in. The engine mints the instance, applies entering
 * counters, fires ETB triggers and runs the state-based actions — so what comes
 * back is a real object with real derived state, never a literal.
 *
 * The turn machine is temporarily parked in the caster's own precombat main with
 * an empty stack, then restored: a POSITION is being built, and gating position
 * construction on whose turn it is would only mean writing the same board by hand
 * instead — which is the thing this module exists to avoid. Timing legality is
 * itself a matrix cell and is tested where it belongs (`legal()` menus), not
 * smuggled in here.
 */
export function castCard(
  state: GameState,
  reg: Registry,
  def: CardDefinition,
  controller: PlayerId = 'A',
  targets?: ReadonlyArray<InstanceId | PlayerId>,
): Resolved {
  const handId = place(state, controller, 'hand', def);
  fund(state, controller);
  const wasActive = state.activePlayer;
  const wasPriority = state.priorityPlayer;
  const wasStep = state.step;
  state.activePlayer = controller;
  state.priorityPlayer = controller;
  state.step = 'precombatMain';
  let next = act(state, { kind: 'castSpell', player: controller, instanceId: handId, targets }, reg);
  next = settle(next, reg);
  if (!next.pendingChoice) {
    next.activePlayer = wasActive;
    next.priorityPlayer = wasPriority;
    next.step = wasStep;
  }
  return { state: next, id: handId };
}

/**
 * {@link castCard}, plus the assertion that the permanent actually LANDED. Use it
 * for the ordinary "this thing is on the board now" setup; use `castCard` when the
 * point of the cell is that the card might not survive its own resolution.
 */
export function resolvePermanent(
  state: GameState,
  reg: Registry,
  def: CardDefinition,
  controller: PlayerId = 'A',
  targets?: ReadonlyArray<InstanceId | PlayerId>,
): Resolved {
  const cast = castCard(state, reg, def, controller, targets);
  if (!cast.state.battlefield.some((perm) => perm.instanceId === cast.id)) {
    throw new Error(`${def.name} did not reach the battlefield (zone: ${zoneOf(cast.state, cast.id)})`);
  }
  return cast;
}

/**
 * PLAY a land through the engine (lands are played, never cast) and return the
 * permanent it became. Like {@link castCard} it parks the turn machine in the
 * player's own main phase and puts it back, and it CLEARS the land-drop counter
 * so a test can build a position with several lands without pretending turns
 * passed. What is being exercised is the land's own entry path - `entersTapped`,
 * an ETB question, a landfall trigger - not the once-per-turn rule, which has
 * its own tests.
 */
export function playLand(
  state: GameState,
  reg: Registry,
  def: CardDefinition,
  controller: PlayerId = 'A',
): Resolved {
  const handId = place(state, controller, 'hand', def);
  const wasActive = state.activePlayer;
  const wasPriority = state.priorityPlayer;
  const wasStep = state.step;
  const wasDrops = state.players[controller].landsPlayedThisTurn;
  state.activePlayer = controller;
  state.priorityPlayer = controller;
  state.step = 'precombatMain';
  state.players[controller].landsPlayedThisTurn = 0;
  let next = act(state, { kind: 'playLand', player: controller, instanceId: handId }, reg);
  next = settle(next, reg);
  if (!next.pendingChoice) {
    next.activePlayer = wasActive;
    next.priorityPlayer = wasPriority;
    next.step = wasStep;
    next.players[controller].landsPlayedThisTurn = wasDrops;
  }
  if (!next.battlefield.some((perm) => perm.instanceId === handId)) {
    throw new Error(`${def.name} did not reach the battlefield (zone: ${zoneOf(next, handId)})`);
  }
  return { state: next, id: handId };
}

/** Where an instance currently is, for a failure message. */
function zoneOf(state: GameState, id: InstanceId): string {
  if (state.battlefield.some((c) => c.instanceId === id)) return 'battlefield';
  if (state.stack.some((o) => o.instanceId === id)) return 'stack';
  for (const pid of ['A', 'B'] as const) {
    for (const zone of ['hand', 'graveyard', 'exile', 'library'] as const) {
      if (state.players[pid][zone].some((c) => c.instanceId === id)) return `${pid}.${zone}`;
    }
  }
  return 'nowhere';
}

/** The permanent with this id, or a loud failure. */
export function onBattlefield(state: GameState, id: InstanceId) {
  const found = state.battlefield.find((perm) => perm.instanceId === id);
  if (!found) throw new Error(`instance ${id} is not on the battlefield (it is in ${zoneOf(state, id)})`);
  return found;
}

/** Whether `id` is on the battlefield at all (for "did it die?" assertions). */
export function isOnBattlefield(state: GameState, id: InstanceId): boolean {
  return state.battlefield.some((perm) => perm.instanceId === id);
}

/** Every legal action right now — the engine's own menu, never a guess. */
export function legal(state: GameState): readonly GameAction[] {
  return generateLegalActions(state, DEFAULT_RULES);
}

/** The legal cast of `instanceId` from `zone`, or undefined when none is offered. */
export function castOffer(
  state: GameState,
  instanceId: InstanceId,
  zone?: 'hand' | 'graveyard' | 'exile',
): Extract<GameAction, { kind: 'castSpell' }> | undefined {
  return legal(state).find(
    (a): a is Extract<GameAction, { kind: 'castSpell' }> =>
      a.kind === 'castSpell' &&
      a.instanceId === instanceId &&
      (zone === undefined || (a.fromZone ?? 'hand') === zone),
  );
}
