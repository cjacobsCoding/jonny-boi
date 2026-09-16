/**
 * FIDELITY GUARD — "faithful or not at all", asserted against the real pool.
 *
 * Two jobs:
 *
 *  1. **The two cards this feature exists for**, played in a real game with the
 *     real registry. Lava Spike is printed "deals 3 damage to target *player or
 *     planeswalker*" and used to be able to kill creatures; Flame Slash is printed
 *     "deals 4 damage to target *creature*" for one mana and used to be an
 *     any-target burn spell — a one-mana four-damage face burn that does not exist
 *     in Magic. Both played strictly BETTER than printed, and a card that plays
 *     better than printed silently corrupts every A/B verdict that includes it.
 *
 *  2. **The audit**, as a standing test rather than a one-off review: every card in
 *     the pool must either be reproduced exactly by the Oracle-text compiler from
 *     its real printed text, or be named in `STUBBED_MECHANICS` with the engine
 *     system it is waiting for. There is no third category — a card cannot be
 *     quietly unfaithful and unlisted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  CardDefinition,
  CardInstance,
  GameEvent,
  GameState,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  generateLegalActions,
  isBoundedTarget,
  isTargetRestriction,
  isTargetSpec,
  targetRestrictionOf,
} from '@jonny-boi/core';
import { buildRegistry } from './pool.js';
import { CARD_POOL } from '../data/pool.js';
import { STUBBED_MECHANICS } from './index.js';
import { compileCard } from './compile/index.js';
import type { CompilableCard } from './compile/index.js';

const SEED = 20260814;

function poolCard(name: string): CardDefinition {
  const card = CARD_POOL.find((entry) => entry.name === name);
  if (!card) throw new Error(`pool missing ${name}`);
  return card;
}

/** A game parked in A's precombat main, mana floating, hands empty. */
function mainPhase(): { state: GameState; registry: ReturnType<typeof buildRegistry> } {
  const registry = buildRegistry();
  const mountain = poolCard('Mountain');
  const { state } = createGame({
    seed: SEED,
    decks: { A: { cards: Array.from({ length: 30 }, () => mountain) }, B: { cards: Array.from({ length: 30 }, () => mountain) } },
    registry,
  });
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
  return { state, registry };
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): InstanceId {
  const instance: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(instance);
  return instance.instanceId;
}

function giveHand(state: GameState, player: PlayerId, def: CardDefinition): InstanceId {
  const instance: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller: player,
    owner: player,
    zone: 'hand',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.players[player].hand.push(instance);
  return instance.instanceId;
}

/** Cast, then let the stack fully resolve. Returns the state and every event. */
function castAndResolve(
  state: GameState,
  registry: ReturnType<typeof buildRegistry>,
  instanceId: InstanceId,
  targets: ReadonlyArray<InstanceId | PlayerId>,
): { state: GameState; events: GameEvent[] } {
  let s = state;
  const events: GameEvent[] = [];
  const drive = (action: Parameters<typeof applyAction>[1]): void => {
    const result = applyAction(s, action, DEFAULT_RULES, registry);
    events.push(...result.events);
    s = result.state;
  };
  drive({ kind: 'castSpell', player: 'A', instanceId, targets });
  let guard = 0;
  while (s.stack.length > 0 && !s.gameOver && guard++ < 20) {
    drive({ kind: 'passPriority', player: s.priorityPlayer });
  }
  return { state: s, events };
}

describe('Lava Spike plays exactly as printed ("target player or planeswalker")', () => {
  const LAVA_SPIKE_DAMAGE = 3;

  it('burns a player for 3', () => {
    const { state, registry } = mainPhase();
    const spike = giveHand(state, 'A', poolCard('Lava Spike'));
    const lifeBefore = state.players.B.life;

    const after = castAndResolve(state, registry, spike, ['B']);
    expect(after.state.players.B.life).toBe(lifeBefore - LAVA_SPIKE_DAMAGE);
  });

  it('cannot be pointed at a creature — not offered, and rejected if forced', () => {
    const { state, registry } = mainPhase();
    const spike = giveHand(state, 'A', poolCard('Lava Spike'));
    // A creature small enough that 3 damage would have killed it before the fix.
    const bear = place(state, poolCard('Goblin Piker'), 'B');

    const offered = generateLegalActions(state, DEFAULT_RULES).filter(
      (a) => a.kind === 'castSpell' && a.instanceId === spike,
    );
    expect(offered.flatMap((a) => (a.kind === 'castSpell' ? [...(a.targets ?? [])] : []))).not.toContain(bear);

    const forced = applyAction(
      state,
      { kind: 'castSpell', player: 'A', instanceId: spike, targets: [bear] },
      DEFAULT_RULES,
      registry,
    );
    expect(forced.events.some((e) => e.type === 'actionRejected')).toBe(true);
    // …and the creature is untouched: no damage, still on the battlefield.
    const survivor = forced.state.battlefield.find((c) => c.instanceId === bear);
    expect(survivor?.damageMarked ?? 0).toBe(0);
  });
});

describe('Flame Slash plays exactly as printed ("target creature")', () => {
  const FLAME_SLASH_DAMAGE = 4;

  it('kills a creature its damage covers', () => {
    const { state, registry } = mainPhase();
    const slash = giveHand(state, 'A', poolCard('Flame Slash'));
    const victim = place(state, poolCard('Centaur Courser'), 'B'); // a 3/3

    const after = castAndResolve(state, registry, slash, [victim]);
    expect(after.state.battlefield.some((c) => c.instanceId === victim)).toBe(false);
    expect(after.events.some((e) => e.type === 'creatureDied')).toBe(true);
    expect(FLAME_SLASH_DAMAGE).toBeGreaterThanOrEqual(poolCard('Centaur Courser').toughness!);
  });

  it('cannot burn a face — not offered, and rejected if forced (a 1-mana 4-damage face burn does not exist)', () => {
    const { state, registry } = mainPhase();
    const slash = giveHand(state, 'A', poolCard('Flame Slash'));
    place(state, poolCard('Centaur Courser'), 'B');
    const lifeBefore = state.players.B.life;

    const offered = generateLegalActions(state, DEFAULT_RULES).filter(
      (a) => a.kind === 'castSpell' && a.instanceId === slash,
    );
    const targets = offered.flatMap((a) => (a.kind === 'castSpell' ? [...(a.targets ?? [])] : []));
    expect(targets).not.toContain('A');
    expect(targets).not.toContain('B');

    const forced = applyAction(
      state,
      { kind: 'castSpell', player: 'A', instanceId: slash, targets: ['B'] },
      DEFAULT_RULES,
      registry,
    );
    expect(forced.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(forced.state.players.B.life).toBe(lifeBefore);
  });

  it('cannot be cast at all with no creature on the board', () => {
    const { state } = mainPhase();
    const slash = giveHand(state, 'A', poolCard('Flame Slash'));
    expect(
      generateLegalActions(state, DEFAULT_RULES).filter(
        (a) => a.kind === 'castSpell' && a.instanceId === slash,
      ),
    ).toHaveLength(0);
  });
});

describe('Absorb is no longer a free three life', () => {
  // "Counter target spell. You gain 3 life." With no target-legality, this was
  // castable into an EMPTY STACK: the counter half no-op'd and the lifegain half
  // resolved anyway — three life for {W}{U}{U} at instant speed, a card that does
  // not exist. The restriction is what makes it uncastable, exactly as printed.
  it('cannot be cast with an empty stack, and gains no life if forced', () => {
    const { state, registry } = mainPhase();
    state.players.A.manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
    const absorb = giveHand(state, 'A', poolCard('Absorb'));
    const lifeBefore = state.players.A.life;

    expect(
      generateLegalActions(state, DEFAULT_RULES).filter(
        (a) => a.kind === 'castSpell' && a.instanceId === absorb,
      ),
    ).toHaveLength(0);

    const forced = applyAction(
      state,
      { kind: 'castSpell', player: 'A', instanceId: absorb, targets: [] },
      DEFAULT_RULES,
      registry,
    );
    expect(forced.events.some((e) => e.type === 'actionRejected')).toBe(true);
    expect(forced.state.players.A.life).toBe(lifeBefore);
  });
});

describe('Monastery Swiftspear grows off every noncreature spell, as prowess prints', () => {
  // Prowess reads "whenever you cast a NONCREATURE spell". Modelled as the positive
  // pair instant+sorcery, it missed every artifact and planeswalker in the pool —
  // ten cards, including Sol Ring and the five Diamonds. That is a card playing
  // WEAKER than printed, which biases a verdict exactly as badly as playing stronger.
  const NONCREATURE_NONSPELL_TYPES = ['artifact', 'enchantment', 'planeswalker'] as const;

  it('has a single negative-filter trigger, not a positive type list', () => {
    const swiftspear = poolCard('Monastery Swiftspear');
    expect(swiftspear.triggers).toHaveLength(1);
    expect(swiftspear.triggers![0]!.condition.spellTypeNoneOf).toEqual(['creature']);
    expect(swiftspear.triggers![0]!.condition.spellType).toBeUndefined();
  });

  it('the pool really does contain noncreature spells that are neither instant nor sorcery', () => {
    const affected = CARD_POOL.filter(
      (card) =>
        !card.types.includes('creature') &&
        !card.types.includes('land') &&
        card.types.some((t) => (NONCREATURE_NONSPELL_TYPES as readonly string[]).includes(t)),
    );
    // If this ever drops to zero the trigger shape stops mattering — but it is 10+.
    expect(affected.length).toBeGreaterThan(0);
  });

  it('pumps when an artifact is cast', () => {
    const { state, registry } = mainPhase();
    const swiftspear = place(state, poolCard('Monastery Swiftspear'), 'A');
    const solRing = giveHand(state, 'A', poolCard('Sol Ring'));

    const after = castAndResolve(state, registry, solRing, []);
    const pumped = after.state.continuous.filter((e) => e.targetInstanceId === swiftspear);
    expect(pumped.length).toBeGreaterThan(0);
    expect(pumped[0]!.power).toBe(1);
    expect(pumped[0]!.toughness).toBe(1);
  });

  it('does NOT pump when a creature is cast', () => {
    const { state, registry } = mainPhase();
    const swiftspear = place(state, poolCard('Monastery Swiftspear'), 'A');
    const goblin = giveHand(state, 'A', poolCard('Goblin Piker'));

    const after = castAndResolve(state, registry, goblin, []);
    expect(after.state.continuous.filter((e) => e.targetInstanceId === swiftspear)).toHaveLength(0);
  });
});

// --- the standing audit ---------------------------------------------------------

/** The normalized Scryfall index every pool card joins to (owned by data-tools). */
const index = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../data-tools/data/card-index.json', import.meta.url)), 'utf8'),
) as { cards: readonly CompilableCard[] };
const scryfallById = new Map(index.cards.map((card) => [card.id, card]));

/**
 * The cards the pool KNOWS are not fully faithful. Every one of these is in
 * `STUBBED_MECHANICS` with the engine system it needs, so this list is derived,
 * not maintained by hand — it exists only so the audit below can say "everything
 * else must be exact".
 */
const KNOWN_UNFAITHFUL = new Set(STUBBED_MECHANICS.map((entry) => entry.card));

/**
 * Behaviour signature: the primitives + params a definition actually runs. Two
 * definitions with the same signature play identically; different signatures do
 * not. (Frame data — cost, P/T, keywords — is covered by the compiler's own
 * ground-truth suite; this is specifically about what the card DOES.)
 */
function behaviour(definition: CardDefinition): string {
  return JSON.stringify({
    effects: (definition.effects ?? []).map((ref) => [ref.primitive, ref.params ?? {}]),
    triggers: (definition.triggers ?? [])
      .map((trigger) => [trigger.condition, trigger.effects.map((ref) => [ref.primitive, ref.params ?? {}])])
      .map((entry) => JSON.stringify(entry))
      .sort(),
    // The display label is presentation, not behaviour; cost + timing + effects
    // are what the ability DOES. Liliana of the Veil is the first card whose
    // whole behaviour lives here, so leaving `activated` out would have let a
    // walker with wrong loyalty costs pass the audit.
    activated: (definition.activated ?? []).map((ability) => [
      ability.cost,
      ability.timing ?? 'instant',
      ability.effects.map((ref) => [ref.primitive, ref.params ?? {}]),
    ]),
    loyalty: definition.loyalty ?? null,
    // A MODAL card's whole behaviour is its modes, not its `effects` — Cryptic
    // Command has no top-level effects at all. Leaving them out would give such
    // a card an EMPTY behaviour signature that matched anything, which is
    // precisely the blind spot this audit exists to close.
    modal: definition.modal
      ? [
          definition.modal.min,
          definition.modal.max,
          definition.modal.allowRepeats ?? false,
          definition.modal.modes.map((mode) => [
            mode.targets ?? null,
            mode.effects.map((ref) => [ref.primitive, ref.params ?? {}]),
          ]),
        ]
      : null,
    // A characteristic-defining P/T IS behaviour — it is what the creature's
    // size DOES at every read. Without it here, a Tarmogoyf compiled with the
    // wrong count (or the wrong offset) would pass the audit silently.
    characteristicPT: definition.characteristicPT ?? null,
    // An as-enters COPY spec is behaviour too, and of the most consequential
    // kind: it decides what the permanent IS. A hand-authored Clone whose
    // filter or "except" tail differed from its printed text would be a
    // different card entirely, and without this line the signature could not
    // tell -- the same blind spot `modal` and `characteristicPT` were added to
    // close.
    copyAsEnters: definition.copyAsEnters ?? null,
  });
}

describe('pool audit — every card claimed faithful really is', () => {
  // Tarmogoyf used to be exempt here: its star box was a FRAME approximation (a
  // pinned 2/3) that a behaviour signature could not see. It is a real formula
  // now, carried in the signature below, so it is audited like everything else.
  for (const authored of CARD_POOL) {
    if (KNOWN_UNFAITHFUL.has(authored.name)) continue;
    it(`${authored.name} is reproduced exactly from its printed text`, () => {
      const scryfall = scryfallById.get(authored.id);
      expect(scryfall, `no Scryfall record for ${authored.name}`).toBeDefined();
      const result = compileCard(scryfall!);

      expect(result.status, `missing: ${JSON.stringify(result.missing)}`).toBe('complete');
      expect(behaviour(result.definition)).toBe(behaviour(authored));
    });
  }

  it('every card the compiler refuses is named in STUBBED_MECHANICS, and vice versa', () => {
    const refused = CARD_POOL.filter((card) => {
      const scryfall = scryfallById.get(card.id);
      return scryfall ? compileCard(scryfall).status !== 'complete' : false;
    }).map((card) => card.name);

    // No silent stubs: nothing may be unfaithful without being on the list.
    expect([...refused].sort()).toEqual([...KNOWN_UNFAITHFUL].filter((n) => refused.includes(n)).sort());
    // No stale entries: everything on the list is still in the pool.
    const poolNames = new Set(CARD_POOL.map((card) => card.name));
    for (const name of KNOWN_UNFAITHFUL) expect(poolNames.has(name), `${name} left the pool`).toBe(true);
  });

  it('every declared target restriction is a value the engine enforces', () => {
    // Asked of the ENGINE (`isTargetSpec`), never of a list copied here: a
    // hand-kept copy goes stale the moment core learns a new restriction, and
    // it did — "Destroy target artifact" compiled to `targets: 'artifact'`,
    // which core has enforced since the attachment work, and this audit called
    // it unenforced anyway. The engine's own predicate cannot drift from the
    // engine.
    //
    // ⚠️ AND THE SAME STALENESS BIT THIS LINE ITSELF, one level up. It asked
    // `isTargetRestriction` — the STRING half — after core grew `TargetSpec`
    // = string | BoundedTarget for printed bounds ("target creature with power
    // 5 or greater"). No card in the SHIPPED pool carried a bounded target, so
    // the audit stayed green on a predicate that had become half an answer; the
    // pool regeneration brought the first ones in and Abrupt Decay
    // (`{base: 'nonlandPermanent', bound: {atMost: {manaValue, 3}}}`) failed it.
    // `isTargetSpec` is the whole question, which is why it is the one to ask.
    for (const card of CARD_POOL) {
      for (const ref of card.effects ?? []) {
        const declared = ref.params?.targets;
        if (declared === undefined) continue;
        expect(
          isTargetSpec(declared),
          // JSON, not String(): a bounded spec stringifies to "[object Object]",
          // which names neither the card's problem nor the shape it declared.
          `${card.name} declares targets: ${JSON.stringify(declared)}`,
        ).toBe(true);
      }
      // …and if it declares a NARROWING one, the engine reads it back. ('any' is
      // the default and is deliberately not reported as a restriction.) A
      // BOUNDED spec is narrowing by construction — it is never built with an
      // empty bound, so there is no "bounded but equivalent to the bare noun".
      const narrow = (card.effects ?? []).some((ref) => {
        const declared = ref.params?.targets;
        return isBoundedTarget(declared) || (isTargetRestriction(declared) && declared !== 'any');
      });
      expect(targetRestrictionOf(card) !== undefined, card.name).toBe(narrow);
    }
  });

  /**
   * SUBTYPES are behaviour, and the {@link behaviour} signature above cannot see
   * them: it deliberately covers only what a card DOES, leaving the frame to the
   * compiler's ground-truth suite — which tests the COMPILER, not a definition
   * somebody typed by hand.
   *
   * Ten hand-authored curated cards had fallen through that gap with an empty
   * type line, and one of them mattered on its own: **Serra Angel was not an
   * Angel**, so Restoration Angel's printed "target NON-ANGEL creature you
   * control" would happily have blinked it (DESIGN §3.43). The same hole was
   * hiding a Goblin from Goblin Chieftain and a Snake from Ophiomancer.
   *
   * Asked of the FRONT face: a DFC's pool definition carries the front face's
   * types at top level (the back is its own `backFace` record) while the index's
   * merged `typeLine` splices both with a literal `//` between them.
   */
  it('every card carries its printed creature/land types', () => {
    for (const card of CARD_POOL) {
      const scryfall = scryfallById.get(card.id);
      if (!scryfall) continue; // reported by the per-card audit above
      const face = scryfall.faces?.[0]?.typeLine ?? scryfall.typeLine;
      const printed = [...face.subtypes].map((s) => s.toLowerCase()).sort();
      const declared = [...(card.subtypes ?? [])].map((s) => s.toLowerCase()).sort();
      expect(declared, `${card.name} — printed "${face.types.join(' ')} — ${face.subtypes.join(' ')}"`).toEqual(
        printed,
      );
    }
  });
});
