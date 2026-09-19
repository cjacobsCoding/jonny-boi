/**
 * THE LOOP A PLAYER CAN ACTUALLY BUILD — the detector against the SHIPPED POOL
 * (DESIGN §3.177). `combo-engine.test.ts` proves the mechanism on hand-built
 * pieces; this proves it on two real cards he can put in a deck today:
 *
 *   Kiki-Jiki, Mirror Breaker — {T}: create a token copy of target nonlegendary
 *   creature you control, except it has haste; sacrifice it at the next end step.
 *   Village Bell-Ringer — when it enters, untap all creatures you control.
 *
 * Tap Kiki-Jiki at the Bell-Ringer: the token enters, its trigger untaps
 * Kiki-Jiki, and the board is exactly as it was plus one hasty Bell-Ringer. Two
 * times round by hand and the engine must offer to run it; twenty more and
 * there must be twenty-two of them. This is the click path the DESIGN section
 * names, played through the same `applyAction` the Play board calls.
 *
 * Loads the pool the way `clone-completeness.test.ts` does; a pool regeneration
 * that drops either card fails here by name rather than silently passing.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import type { CardDefinition, CardInstance, GameAction, GameState, RulesConfig } from '@jonny-boi/core';
import { applyAction, createGame, DEFAULT_RULES } from '@jonny-boi/core';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const def = pool.cards.find((c) => c.name === name);
  if (!def) throw new Error(`"${name}" is not in the shipped pool — the click path in DESIGN §3.177 names it`);
  return def;
}

const KIKI = 'Kiki-Jiki, Mirror Breaker';
const BELL = 'Village Bell-Ringer';
const REPEATS = 20;

/** The Play session's Solo rules: seat A is the human. */
const SOLO_HUMAN_A: RulesConfig = { ...DEFAULT_RULES, comboDetectionSeats: ['A'], maximumHandSize: Number.MAX_SAFE_INTEGER };

interface Table {
  state: GameState;
  readonly kiki: number;
  readonly bell: number;
}

function table(): Table {
  const mountain = card('Mountain');
  const created = createGame({
    seed: 5,
    startingPlayer: 'A',
    registry,
    config: SOLO_HUMAN_A,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => mountain) },
      B: { cards: Array.from({ length: 40 }, () => mountain) },
    },
  });
  const state = created.state;
  const put = (def: CardDefinition): number => {
    const inst: CardInstance = {
      instanceId: state.nextInstanceId++,
      def,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
    };
    state.battlefield.push(inst);
    return inst.instanceId;
  };
  const t: Table = { state, kiki: put(card(KIKI)), bell: put(card(BELL)) };
  while (t.state.step !== 'precombatMain') apply(t, { kind: 'passPriority', player: t.state.priorityPlayer });
  return t;
}

function apply(t: Table, action: GameAction): void {
  const result = applyAction(t.state, action, SOLO_HUMAN_A, registry);
  const rejected = result.events.find((e) => e.type === 'actionRejected');
  if (rejected && rejected.type === 'actionRejected') throw new Error(`${action.kind} rejected: ${rejected.reason}`);
  t.state = result.state;
}

/** One time round by hand: tap Kiki-Jiki at the Bell-Ringer, then pass until the board settles. */
function cycle(t: Table): void {
  apply(t, { kind: 'activateAbility', player: 'A', instanceId: t.kiki, abilityIndex: 0, targets: [t.bell] });
  for (let i = 0; i < 12 && t.state.stack.length > 0 && !t.state.comboWindow; i++) {
    if (t.state.pendingChoice) throw new Error(`the loop asked a question: ${t.state.pendingChoice.prompt}`);
    apply(t, { kind: 'passPriority', player: t.state.priorityPlayer });
  }
}

const tokens = (t: Table): number => t.state.battlefield.filter((c) => c.def.isToken === true).length;
const kikiTapped = (t: Table): boolean => t.state.battlefield.find((c) => c.instanceId === t.kiki)!.tapped;

describe('Kiki-Jiki, Mirror Breaker + Village Bell-Ringer, from the shipped pool', () => {
  it('two times round by hand opens the window: +1 Village Bell-Ringer per cycle', () => {
    const t = table();
    cycle(t);
    expect(tokens(t)).toBe(1);
    expect(kikiTapped(t), 'the token\'s trigger untapped Kiki-Jiki').toBe(false);
    expect(t.state.comboWindow ?? null).toBeNull();
    cycle(t);
    const window = t.state.comboWindow;
    expect(window, 'the window opens after the second cycle').toBeTruthy();
    if (!window) return;
    expect(window.owner).toBe('A');
    expect(window.loop.deltas.map((d) => d.label)).toEqual([`+1 ${BELL}`]);
    // activate · pass · pass (the token enters, its trigger goes on the stack) · pass · pass
    expect(window.loop.cycle.map((a) => `${a.kind}:${a.player}`)).toEqual([
      'activateAbility:A',
      'passPriority:A',
      'passPriority:B',
      'passPriority:A',
      'passPriority:B',
    ]);
  });

  it(`repeatCombo ${REPEATS} leaves ${REPEATS + 2} hasty Bell-Ringers, Kiki-Jiki untapped and the window closed`, () => {
    const t = table();
    cycle(t);
    cycle(t);
    apply(t, { kind: 'repeatCombo', player: 'A', times: REPEATS });
    expect(tokens(t)).toBe(REPEATS + 2);
    expect(kikiTapped(t)).toBe(false);
    expect(t.state.comboWindow).toBeNull();
    expect(t.state.stack).toHaveLength(0);
    expect(t.state.gameOver).toBe(false);
    // Every token still owes its end-step sacrifice: the delayed triggers rode
    // along with the tokens, one each, because the replay is the real thing.
    expect(t.state.delayedTriggers?.length ?? 0).toBe(REPEATS + 2);
  });
});
