/**
 * THE COMBAT-DAMAGE / EQUIPMENT FAMILY, from printed Oracle text to a real game.
 *
 * Two things are asserted here, and they fail independently:
 *
 *  1. **The compiler builds the right DATA.** "Whenever equipped creature deals
 *     combat damage to a player" must become the SAME `combatDamageToPlayer`
 *     condition the creature's own line does, scoped with `watches:
 *     'attachedHost'` — because a trigger that fires on the wrong object is a
 *     card with an ability it does not have, and nothing downstream can notice.
 *     What still has no faithful implementation must REPORT, by clause.
 *  2. **A real game actually fires it.** The pilot plays the Equipment, equips
 *     it, attacks, connects, and draws the card. Every one of those steps has
 *     been silently missing before — most recently the equip search itself,
 *     which skipped any Equipment with no P/T modification.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, GameAction, GameEvent, GameState } from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  createRng,
  applyEffectRef,
  DEFAULT_RULES,
  effectiveKeywords,
  generateLegalActions,
  indexContinuous,
  NO_MOD,
} from '@jonny-boi/core';
import { createHeuristicPilot } from '@jonny-boi/ai';
import { buildRegistry } from './pool.js';
import { compileCard } from './compile/compile.js';
import type { CompilableCard } from './compile/types.js';

const NO_MANA = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] as readonly string[] };

function scryfall(parts: {
  name: string;
  cost?: Partial<typeof NO_MANA>;
  types: readonly string[];
  subtypes?: readonly string[];
  oracleText: string;
  keywords?: readonly string[];
  power?: number | null;
  toughness?: number | null;
}): CompilableCard {
  return {
    id: `equipped:${parts.name}`,
    name: parts.name,
    manaCost: { ...NO_MANA, ...parts.cost },
    typeLine: { supertypes: [], types: parts.types, subtypes: parts.subtypes ?? [] },
    oracleText: parts.oracleText,
    power: parts.power ?? null,
    toughness: parts.toughness ?? null,
    keywords: parts.keywords ?? [],
  };
}

/** Compile the way the deck importer does, insisting the card be fully playable. */
function playable(card: CompilableCard): CardDefinition {
  const result = compileCard(card);
  expect(result.status, `${card.name}: ${JSON.stringify(result.missing)}`).toBe('complete');
  return result.definition;
}

/** An Equipment shell so a single printed line can be compiled in isolation. */
function equipment(name: string, text: string): CompilableCard {
  return scryfall({
    name,
    cost: { generic: 2 },
    types: ['Artifact'],
    subtypes: ['Equipment'],
    keywords: ['Equip'],
    oracleText: `${text}\nEquip {2}`,
  });
}

// --- the compiled data -----------------------------------------------------------

describe('the equipped-creature trigger compiles to the host-watching condition', () => {
  it('is the SAME event as the creature’s own line, watched on the host', () => {
    const sword = playable(
      equipment('Test Sword', 'Whenever equipped creature deals combat damage to a player, draw a card.'),
    );
    expect(sword.triggers?.[0]?.condition).toEqual({
      on: 'combatDamageToPlayer',
      watches: 'attachedHost',
    });

    // The creature's own printed line is the same event with NO watch scope —
    // absent, not `'self'`, so every trigger authored before this existed is
    // byte-identical data.
    const creature = playable(
      scryfall({
        name: 'Test Rogue',
        cost: { B: 1 },
        types: ['Creature'],
        subtypes: ['Rogue'],
        power: 1,
        toughness: 1,
        oracleText: 'Whenever Test Rogue deals combat damage to a player, draw a card.',
      }),
    );
    expect(creature.triggers?.[0]?.condition).toEqual({ on: 'combatDamageToPlayer' });
  });

  it('compiles the attacks and dies forms, and the "enchanted creature" wording', () => {
    const onAttack = playable(equipment('Test Banner', 'Whenever equipped creature attacks, draw a card.'));
    expect(onAttack.triggers?.[0]?.condition).toEqual({ on: 'attacks', watches: 'attachedHost' });

    // Skullclamp's whole card.
    const clamp = playable(
      scryfall({
        name: 'Skullclamp',
        cost: { generic: 1 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText: 'Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}',
      }),
    );
    expect(clamp.triggers?.[0]?.condition).toEqual({ on: 'dies', watches: 'attachedHost' });
    expect(clamp.attachment?.modifies).toEqual({ power: 1, toughness: -1, keywords: {} });

    // An Aura prints the same ability with the other noun.
    const aura = playable(
      scryfall({
        name: 'Test Mantle',
        cost: { U: 1 },
        types: ['Enchantment'],
        subtypes: ['Aura'],
        keywords: ['Enchant'],
        oracleText:
          'Enchant creature\nWhenever enchanted creature deals combat damage to a player, draw a card.',
      }),
    );
    expect(aura.triggers?.[0]?.condition).toEqual({
      on: 'combatDamageToPlayer',
      watches: 'attachedHost',
    });
  });

  it('compiles the "you may" form as a real question, not a forced clause', () => {
    const sword = playable(
      equipment('Test Mask', 'Whenever equipped creature deals combat damage to a player, you may draw two cards.'),
    );
    const effects = sword.triggers?.[0]?.effects ?? [];
    expect(effects.map((e) => e.primitive)).toEqual(['mayEffects']);
    const inner = (effects[0]?.params as { effects?: readonly { primitive: string }[] }).effects ?? [];
    expect(inner.map((e) => e.primitive)).toEqual(['drawCards']);
  });

  it('REFUSES a host-watching trigger on a card with no way to attach', () => {
    // A creature cannot print "whenever equipped creature …", and a compiler that
    // emitted the trigger anyway would produce a permanent whose ability can
    // never fire — attached to nothing, forever.
    const creature = compileCard(
      scryfall({
        name: 'Impossible Ogre',
        cost: { R: 1 },
        types: ['Creature'],
        subtypes: ['Ogre'],
        power: 2,
        toughness: 2,
        oracleText: 'Whenever equipped creature deals combat damage to a player, draw a card.',
      }),
    );
    expect(creature.status).toBe('incomplete');
    expect(creature.missing.map((m) => m.missingEngineSystem)).toContain(
      'auras and equipment attachment (no "Enchant …" or "Equip {N}" line to attach it)',
    );
  });
});

describe('the printed cards this family was measured against', () => {
  it('plays Sword of Fire and Ice, Argentum Armor, Lavaspur Boots and Sword of the Animist', () => {
    const fireAndIce = playable(
      scryfall({
        name: 'Sword of Fire and Ice',
        cost: { generic: 3 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText:
          'Equipped creature gets +2/+2 and has protection from red and from blue.\n' +
          'Whenever equipped creature deals combat damage to a player, Sword of Fire and Ice deals 2 damage to any target and you draw a card.\n' +
          'Equip {2}',
      }),
    );
    // Both halves of the printed modification, including the payload keyword.
    expect(fireAndIce.attachment?.modifies).toEqual({
      power: 2,
      toughness: 2,
      keywords: { protectionFrom: ['red', 'blue'] },
    });
    // The trigger AIMS: core chooses its target as the ability goes on the stack.
    expect(fireAndIce.triggers?.[0]?.targets).toBe('any');
    expect(fireAndIce.triggers?.[0]?.effects.map((e) => e.primitive)).toEqual(['dealDamage', 'drawCards']);

    const armor = playable(
      scryfall({
        name: 'Argentum Armor',
        cost: { generic: 6 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText:
          'Equipped creature gets +6/+6.\nWhenever equipped creature attacks, destroy target permanent.\nEquip {6}',
      }),
    );
    expect(armor.triggers?.[0]?.targets).toBe('permanent');

    const boots = playable(
      scryfall({
        name: 'Lavaspur Boots',
        cost: { generic: 1 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText: 'Equipped creature gets +1/+0 and has haste and ward {1}.\nEquip {1}',
      }),
    );
    expect(boots.attachment?.modifies).toEqual({
      power: 1,
      toughness: 0,
      keywords: { haste: true, ward: 1 },
    });

    playable(
      scryfall({
        name: 'Sword of the Animist',
        cost: { generic: 2 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText:
          'Equipped creature gets +1/+1.\n' +
          'Whenever equipped creature attacks, you may search your library for a basic land card, put it onto the battlefield tapped, then shuffle.\n' +
          'Equip {2}',
      }),
    );
  });

  it('plays Mask of Memory — the whole card is one optional clause', () => {
    // "You may draw two cards. If you do, discard a card." The option is
    // all-or-nothing, so "if you do" is exactly "the may was taken" — and the
    // discard is the CONTROLLER's own, which is the half a default-to-the-target
    // implementation gets wrong (there is no target here at all).
    const mask = playable(
      scryfall({
        name: 'Mask of Memory',
        cost: { generic: 2 },
        types: ['Artifact'],
        subtypes: ['Equipment'],
        keywords: ['Equip'],
        oracleText:
          'Whenever equipped creature deals combat damage to a player, you may draw two cards. If you do, discard a card.\nEquip {1}',
      }),
    );
    const may = mask.triggers?.[0]?.effects[0];
    expect(may?.primitive).toBe('mayEffects');
    const inner = (may?.params as { effects?: readonly { primitive: string; params?: Record<string, unknown> }[] })
      .effects;
    expect(inner?.map((e) => e.primitive)).toEqual(['drawCards', 'discardCard']);
    expect(inner?.[1]?.params?.who).toBe('controller');
  });

  it('REPORTS the clauses that still have no faithful implementation, by clause', () => {
    // Every one of these is a real printed card whose combat-damage trigger the
    // engine cannot honour yet. Each must report the SPECIFIC clause rather than
    // compiling a near-miss — an approximate Sword biases every A/B verdict that
    // contains it.
    const cases: ReadonlyArray<{ name: string; text: string; clause: string }> = [
      {
        name: 'Goldvein Pick',
        text: 'Whenever equipped creature deals combat damage to a player, create a Treasure token.',
        clause: 'whenever equipped creature deals combat damage to a player, create a treasure token',
      },
      {
        name: 'Sword of Feast and Famine',
        text: 'Whenever equipped creature deals combat damage to a player, that player discards a card and you untap all lands you control.',
        clause: 'that player discards a card',
      },
      {
        name: 'Sword of Truth and Justice',
        text: 'Whenever equipped creature deals combat damage to a player, put a +1/+1 counter on a creature you control, then proliferate.',
        clause: 'proliferate',
      },
    ];
    for (const probe of cases) {
      const result = compileCard(equipment(probe.name, probe.text));
      expect(result.status, probe.name).toBe('incomplete');
      const texts = result.missing.map((m) => m.text.toLowerCase()).join(' | ');
      expect(texts, probe.name).toContain(probe.clause);
    }

    // The static half reports on its own terms: core knows colours, artifacts and
    // creatures as protection qualities, and nothing else.
    const wealth = compileCard(
      equipment(
        'Sword of Wealth and Power',
        'Equipped creature gets +2/+2 and has protection from instants and from sorceries.',
      ),
    );
    expect(wealth.status).toBe('incomplete');
    expect(wealth.missing.map((m) => m.missingEngineSystem)).toContain(
      'a ward/protection template the compiler does not recognize yet',
    );
  });
});

describe('a GRANTED payload keyword actually reaches the board', () => {
  /**
   * The bug this exists for, found while widening `parseKeywordList` to the two
   * payload keywords: `keywordsParam` kept only `=== true` values, so
   * `protectionFrom` (a list) and `ward`/`minBlockers` (numbers) were dropped on
   * the way into every until-end-of-turn grant. "Target creature gains
   * protection from red until end of turn" compiled `'complete'` and did
   * NOTHING — and the rule's own test stayed green because it asserted the
   * compiled EFFECT REFS and never played the card.
   *
   * So this one plays it: the grant resolves through the real registered
   * primitive and is read back through core's continuous layer, which is the
   * only thing that can tell a real grant from an empty one.
   */
  it('grants protection from red, not an empty modification', () => {
    const registry = buildRegistry();
    const spell = playable(
      scryfall({
        name: 'Test Ward Off Red',
        cost: { W: 1 },
        types: ['Instant'],
        oracleText: 'Target creature gains protection from red until end of turn.',
      }),
    );
    const bear: CardDefinition = {
      id: 'equipped:Test Bear',
      name: 'Test Bear',
      types: ['creature'],
      power: 2,
      toughness: 2,
      cost: { G: 1 },
    };
    const { state } = createGame({ seed: 4, decks: { A: deckWith([bear]), B: deckWith([]) }, registry });
    const target: CardInstance = {
      instanceId: state.nextInstanceId++,
      def: bear,
      controller: 'A',
      owner: 'A',
      zone: 'battlefield',
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      counters: {},
      attachedTo: null,
    };
    state.battlefield.push(target);

    const effect = spell.effects?.[0];
    expect(effect?.primitive).toBe('grantKeywordUntilEndOfTurn');
    // Resolved through CORE's own `applyEffectRef`, not a hand-built context:
    // the continuous effect has to land in the shape `indexContinuous` reads,
    // and a stub that pushed its own shape would pass while the real spell did
    // nothing — the exact failure this test exists to catch.
    applyEffectRef(
      registry,
      effect!,
      { state, source: target, controller: 'A' },
      () => {},
      [target.instanceId],
    );

    const granted = effectiveKeywords(target, indexContinuous(state).get(target.instanceId) ?? NO_MOD);
    expect(granted.protectionFrom, 'the grant reached the board as an EMPTY modification').toEqual(['red']);
  });
});

// --- a real game -----------------------------------------------------------------

const FOREST: CardDefinition = { id: 'equipped:Forest', name: 'Forest', types: ['land'], produces: ['G'] };

/** A cheap body to carry the Sword. */
const SCOUT: CardDefinition = {
  id: 'equipped:Scout',
  name: 'Scout',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { G: 1 },
};

/** Sword of the Animist's shape, with a body the engine can observe: a draw. */
const DRAW_SWORD = playable(
  equipment('Draw Sword', 'Whenever equipped creature deals combat damage to a player, draw a card.'),
);

function deckWith(key: readonly CardDefinition[], copies = 8): { cards: readonly CardDefinition[] } {
  const cards: CardDefinition[] = [];
  for (let i = 0; i < copies; i++) cards.push(...key);
  while (cards.length < 40) cards.push(FOREST);
  return { cards };
}

interface PlayedGame {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly actions: readonly GameAction[];
}

/** Play a real game with the heuristic pilot on both seats and record everything. */
function playGame(
  decks: { A: { cards: readonly CardDefinition[] }; B: { cards: readonly CardDefinition[] } },
  seed: number,
  maxActions = 600,
): PlayedGame {
  const registry = buildRegistry();
  const pilot = createHeuristicPilot();
  const rng = createRng(seed);
  const created = createGame({ seed, decks, registry });
  let state = created.state;
  const events: GameEvent[] = [...created.events];
  const actions: GameAction[] = [];
  for (let i = 0; i < maxActions && !state.gameOver; i++) {
    const legal = generateLegalActions(state, DEFAULT_RULES);
    if (legal.length === 0) break;
    const chosen = pilot.chooseAction({ view: state, legalActions: legal, rng, registry });
    const result = applyAction(state, chosen, DEFAULT_RULES, registry);
    state = result.state;
    events.push(...result.events);
    actions.push(chosen);
  }
  return { state, events, actions };
}

describe('a real game fires the equipped creature’s trigger', () => {
  it('equips, connects, and the Sword’s ability draws the card', () => {
    const game = playGame({ A: deckWith([SCOUT, DRAW_SWORD]), B: deckWith([]) }, 20260820);

    // The three steps, each asserted separately, because each has been the one
    // that was silently missing at some point.
    expect(
      game.events.some((e) => e.type === 'permanentAttached'),
      'the pilot never equipped the Sword — a trigger-only Equipment is inert if nothing picks it up',
    ).toBe(true);

    const fired = game.events.filter(
      (e) => e.type === 'triggerPutOnStack' && e.label.startsWith('Equipped creature deals combat damage'),
    );
    expect(fired.length, 'the equipped creature connected but the Sword never triggered').toBeGreaterThan(0);

    // The trigger's SOURCE is the Sword, never the creature that swung.
    for (const event of fired) {
      const source = (event as { sourceInstanceId: number }).sourceInstanceId;
      const permanent =
        game.state.battlefield.find((c) => c.instanceId === source) ??
        [...game.state.players.A.graveyard, ...game.state.players.B.graveyard].find(
          (c) => c.instanceId === source,
        );
      expect(permanent?.def.name, 'the trigger fired from the wrong object').toBe('Draw Sword');
    }
  });

  it('does not fire for a creature the Sword is not on', () => {
    // The control: the same deck with the Sword replaced by an artifact whose
    // trigger watches ITSELF. An Equipment never deals combat damage, so the
    // ability can never fire — and if it does, the watch scope is being ignored.
    const selfWatching: CardDefinition = {
      ...DRAW_SWORD,
      id: 'equipped:Self Sword',
      name: 'Self Sword',
      triggers: [
        {
          condition: { on: 'combatDamageToPlayer' },
          effects: [{ primitive: 'drawCards', params: { count: 1 } }],
          label: 'Self-watching combat damage',
        },
      ],
    };
    const game = playGame({ A: deckWith([SCOUT, selfWatching]), B: deckWith([]) }, 20260820);
    expect(
      game.events.some((e) => e.type === 'triggerPutOnStack' && e.label === 'Self-watching combat damage'),
    ).toBe(false);
  });
});
