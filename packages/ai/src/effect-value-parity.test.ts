/**
 * PRIMITIVE/VALUE PARITY — the §3.49 invariant for the §3.42 class.
 *
 * §3.42 was two primitives (`mayEffects`, `blinkTarget`) that were REGISTERED
 * in the cards package and absent from the AI's value table, so both scored
 * the flat `modeUnknownEffectScore` — and a wrapper's nested body was never
 * read at all. No test could see it, because every value test priced an id it
 * KNEW. This file quantifies over the two live registries instead:
 *
 *  1. every PRICED id is REGISTERED — a price for a primitive that no longer
 *     exists is a dead entry and a sign the tables have drifted;
 *  2. every REGISTERED id is PRICED — or carried, visibly, on the
 *     KNOWN_UNPRICED ledger below. A NEW primitive lands red here until it is
 *     priced or deliberately ledgered; deleting a price (the §3.42 revert)
 *     lands red the same way;
 *  3. the ledger itself cannot go stale: an entry that has since been priced,
 *     or un-registered, fails until it is removed;
 *  4. every primitive id REFERENCED anywhere in pool data — including refs
 *     NESTED inside another ref's params, which `loadCardPool`'s top-level
 *     validation never walks — is registered;
 *  5. every WRAPPER primitive the pool actually uses (a ref whose params carry
 *     nested effect refs) RECURSES: its value must be SENSITIVE to what the
 *     nested body is. An unpriced or flat-priced wrapper scores a rich body
 *     and an empty body identically, which is exactly how Conjurer's Closet
 *     ate its own Soldiers.
 *
 * The ledger is the §3.28 manifest pattern: today's debt is carried in the
 * open with a reason per id, and the INVARIANT — no primitive is silently
 * unpriced — holds for everything that comes after.
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition, CardInstance, EffectRef, GameState } from '@jonny-boi/core';
import { CARD_POOL, CORE_PRIMITIVE_IDS } from '@jonny-boi/cards';
import { PRICED_PRIMITIVE_IDS, resolutionValueContext, valueOfEffect } from './effect-value.js';
import { cardValueContext } from './card-value.js';
import { boardIndex } from './board-stats.js';
import { DEFAULT_HEURISTIC_WEIGHTS } from './weights.js';

/**
 * REGISTERED-BUT-UNPRICED, acknowledged. Every id here scores the flat
 * `modeUnknownEffectScore`: the pilot cannot tell two candidates apart by this
 * effect, which is a §3.42-shaped blind spot in the open rather than a bug in
 * hiding. Pricing them is `packages/ai` behaviour work (owned elsewhere at the
 * time of §3.49); each entry names what goes blind while it waits. Pool ref
 * counts as of §3.49.
 *
 * ⚠️ The ledger is ENFORCED in both directions: pricing one of these without
 * removing its row fails the stale-ledger check; adding a primitive without
 * pricing it fails the parity check unless a row is added HERE, in review's
 * plain sight.
 */
const KNOWN_UNPRICED: Readonly<Record<string, string>> = Object.freeze({
  attachToTarget:
    'x42 in pool, and STAYING ledgered after §3.52, measured rather than assumed: every live decision ' +
    'that aims this ref goes around the value table — the 24 Equip activations through bestEquipPlay ' +
    '(host-aware: scoreEquip + equipIsAnUpgrade) and the 18 Aura casts through the attachment intent ' +
    '(biggestThreat host, helpful/harmful by the grant’s sign) — and the ref itself cannot be priced by ' +
    'params shape: its value IS the source card’s `attachment.modifies`, which EffectValueContext does ' +
    'not carry. A price here would be dead code wearing a green checkmark. If a TRIGGER or MODE ever ' +
    'carries this ref, the parity sweep holds this row up for re-judging.',
  // The two delayed-ability bodies (CR 603.7). Never chosen BY a pilot: they run
  // only as the body of a delayed trigger the engine fires, with their subject
  // baked into params — so a price would steer nothing. The doomed-chump combat
  // pricing (delayedRemovalTargets) is where the pilot actually reasons about
  // them.
  sacrificeNamed: 'delayed-trigger body only — never on a pilot menu; combat prices the doom instead',
  exileNamed: 'delayed-trigger body only — never on a pilot menu; combat prices the doom instead',
  // The three CAST-TRIGGER bodies (§3.113, `CardDefinition.castTriggers`). Same
  // shape as `attachToTarget`'s row: a price here would be dead code wearing a
  // green checkmark. They are never on a pilot menu — the engine pushes them
  // itself as the spell is cast, and nothing offers a choice about whether they
  // run — and storm's value is not computable from the params in any case: it is
  // the COUNT of spells cast before it (which rides the trigger's
  // `triggeringAmount`) times the payload of the spell on the stack, neither of
  // which `EffectValueContext` carries. Where the pilot DOES decide — which
  // spell to cast, and when — storm and cascade are priced by
  // `castTriggerBonus` in `heuristic.ts`, off the live spell count.
  stormCopies: 'cast-trigger body only; its value is triggeringAmount × the stack spell’s payload, neither in the context — priced at the cast by castTriggerBonus',
  cascade: 'cast-trigger body only — never on a pilot menu; the cast decision is priced by castTriggerBonus',
  ripple: 'cast-trigger body only — never on a pilot menu; a same-name hit in the top N is a decklist fact the pilot has no model for',
  // §3.106 — the two upkeep TICKS. Trigger bodies the engine fires, never a
  // pilot's pick; what they cost the pilot is read off the counters themselves
  // (card-value.ts's `temporaryShare` prices a vanishing/fading permanent by
  // its counters left; a suspended card is priced by the spell it becomes).
  tickDownCounter: 'upkeep-trigger body only — the pilot prices the time/fade counters through cardValue',
  suspendTick: 'delayed-trigger body only — the free cast it leads to is priced as the spell itself',
  // §3.111 — the graveyard-casting family's bodies. Every one reads its SOURCE
  // (the card in the graveyard or in exile) and the value context carries no
  // source, so a price here could only be flat. The pilot prices them where the
  // source IS known: `bestGraveyardAbility` in heuristic.ts, by the closed
  // `GraveyardAbilityKind` table (an unearth is one attack, a scavenge is
  // counters on the best attacker, an embalm is a body, a return is a card).
  unearthReturn: 'graveyard-ability body — priced by kind in bestGraveyardAbility, which knows the source',
  scavengeCounters: 'graveyard-ability body — priced by kind in bestGraveyardAbility, which knows the source',
  graveyardTokenCopy: 'graveyard-ability body — priced by kind in bestGraveyardAbility, which knows the source',
  returnSourceFromGraveyard:
    'graveyard-ability body and Rancor’s trigger body — priced by kind in bestGraveyardAbility; as a trigger it is card advantage the pilot cannot steer',
  createEmblem: 'unreachable from pool refs today; an emblem would score flat',
  fight: 'unreachable from pool refs today; a fight would score flat, blind to both bodies',
  returnChosenToHand: 'unreachable from pool refs today',
  wardCounterUnlessPaid: 'unreachable from pool refs today; ward’s tax is priced elsewhere',
  blinkSelf: 'unreachable from pool refs today; the pilot’s blink goal prices the PLAY, not this ref',
});

// --- generic pool traversal -------------------------------------------------------

/**
 * Visit every effect ref a card carries, WHEREVER it hides: resolution
 * effects, triggers, activated abilities, back faces, modal specs — and refs
 * nested inside another ref's params (`mayEffects`' body, `ifKicked`'s body).
 * Purely structural: anything object-shaped with a string `primitive` field is
 * a ref, so a nesting shape invented next month is swept without a change
 * here.
 */
function walkCardRefs(card: CardDefinition, visit: (ref: EffectRef, path: string) => void): void {
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.primitive === 'string') visit(record as unknown as EffectRef, path);
    for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`);
  };
  walk(card, card.name);
}

/** Param keys on `ref` whose value carries at least one nested effect ref. */
function nestedRefParams(ref: EffectRef): string[] {
  const keys: string[] = [];
  const holdsRef = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(holdsRef);
    const record = value as Record<string, unknown>;
    if (typeof record.primitive === 'string') return true;
    return Object.values(record).some(holdsRef);
  };
  for (const [key, value] of Object.entries(ref.params ?? {})) {
    if (holdsRef(value)) keys.push(key);
  }
  return keys;
}

// --- a real-enough board for pricing (same shape as blink-value.test.ts) ----------

const VANILLA: CardDefinition = {
  id: 'parity-vanilla',
  name: 'parity-vanilla',
  types: ['creature'],
  power: 2,
  toughness: 2,
  cost: { generic: 2 },
};

function pricingState(): GameState {
  const library = () =>
    Array.from({ length: 20 }, (_, i) => ({
      instanceId: 900 + i,
      def: VANILLA,
      controller: 'A',
      owner: 'A',
      zone: 'library',
    })) as unknown as CardInstance[];
  const seat = () => ({
    life: 20,
    hand: [],
    library: library(),
    graveyard: [],
    exile: [],
    command: [],
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    landsPlayedThisTurn: 0,
    hasLost: false,
  });
  const state = {
    battlefield: [] as CardInstance[],
    players: { A: seat(), B: seat() },
    nextInstanceId: 1,
    stack: [],
    continuous: [],
    turnNumber: 1,
    step: 'precombatMain',
    activePlayer: 'A',
    priorityPlayer: 'A',
    gameOver: false,
  } as unknown as GameState;
  const id = state.nextInstanceId++;
  state.battlefield.push({
    instanceId: id,
    def: VANILLA,
    controller: 'A',
    owner: 'A',
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    attachedTo: null,
    counters: {},
  } as unknown as CardInstance);
  return state;
}

/** A nested body with unmistakable positive value on `pricingState`. */
const RICH_BODY: EffectRef[] = [{ primitive: 'drawCards', params: { amount: 5 } }];

function priceOnBoard(ref: EffectRef): number {
  const state = pricingState();
  const index = boardIndex(state);
  const base = resolutionValueContext(state, 'A', DEFAULT_HEURISTIC_WEIGHTS, cardValueContext(state, index));
  const firstPermanent = state.battlefield[0]!.instanceId;
  return valueOfEffect(ref, { ...base, targets: [firstPermanent] });
}

// --- the invariants ---------------------------------------------------------------

describe('primitive/value parity (§3.42 class)', () => {
  const registered = new Set(CORE_PRIMITIVE_IDS);
  const priced = new Set(PRICED_PRIMITIVE_IDS);

  it('every priced id is a registered primitive — no dead price entries', () => {
    for (const id of priced) {
      expect(registered.has(id), `EFFECT_VALUE prices '${id}', which no registry provides`).toBe(true);
    }
  });

  it('every registered primitive is priced, or carried openly on the ledger', () => {
    const silent = CORE_PRIMITIVE_IDS.filter((id) => !priced.has(id) && KNOWN_UNPRICED[id] === undefined);
    expect(
      silent,
      'registered primitives with NO value entry and NO ledger row — price them in effect-value.ts, ' +
        'or add a ledger row with an honest reason (this is how §3.42 went unseen)',
    ).toEqual([]);
  });

  it('the ledger cannot go stale', () => {
    for (const [id, reason] of Object.entries(KNOWN_UNPRICED)) {
      expect(reason.length, `ledger row for '${id}' needs a reason`).toBeGreaterThan(0);
      expect(registered.has(id), `'${id}' is on the ledger but is no longer a registered primitive`).toBe(true);
      expect(priced.has(id), `'${id}' is on the ledger but HAS a price now — remove its row`).toBe(false);
    }
  });

  it('every primitive referenced anywhere in pool data — nested bodies included — is registered', () => {
    // Extends loadCardPool's validation, which walks only TOP-LEVEL refs on
    // effects/triggers/activated: a wrapper body naming a bogus primitive
    // would load without a warning and silently no-op at resolution.
    const unknown: string[] = [];
    for (const card of CARD_POOL) {
      walkCardRefs(card, (ref, path) => {
        if (!registered.has(ref.primitive)) unknown.push(`${path} -> '${ref.primitive}'`);
      });
    }
    expect(unknown, 'pool refs pointing at primitives no registry provides').toEqual([]);
  });
});

describe('wrapper primitives recurse (§3.42 class)', () => {
  it('every wrapper the pool uses prices its body — a rich body and an empty body must differ', () => {
    // Discover the wrappers from DATA: any pool ref with a param carrying
    // nested refs. Today that finds `mayEffects` (priced, recursing) and
    // `ifKicked` (on the ledger); tomorrow it finds whatever is authored next.
    const wrappers = new Map<string, { paramKeys: Set<string>; example: string }>();
    for (const card of CARD_POOL) {
      walkCardRefs(card, (ref, path) => {
        const keys = nestedRefParams(ref);
        if (keys.length === 0) return;
        const found = wrappers.get(ref.primitive) ?? { paramKeys: new Set<string>(), example: path };
        for (const key of keys) found.paramKeys.add(key);
        wrappers.set(ref.primitive, found);
      });
    }
    expect(wrappers.size, 'the pool carries wrapper primitives; discovery finding none is itself a failure').toBeGreaterThan(0);

    const flat: string[] = [];
    for (const [primitive, { paramKeys, example }] of wrappers) {
      if (KNOWN_UNPRICED[primitive] !== undefined) continue; // carried openly, checked above
      // ⚠️ EVERY BODY PARAM IS VARIED, and at least one must move the price.
      //
      // Varying only the FIRST one was a false alarm on a two-BRANCH wrapper.
      // `substituteIf` ("<base>; if <condition>, <other> INSTEAD") prices the
      // branch the current board would actually run, which is correct and is
      // the whole reason it recurses — but the probe passes no condition, so the
      // board runs the OTHER branch, and swapping the first branch's body
      // changed nothing. The wrapper was reading its bodies; the probe was only
      // looking at one of them.
      //
      // "At least one" rather than "all": a branch that this board would not run
      // is legitimately worth nothing, and demanding every branch move the price
      // would forbid the very precision that makes the recursion useful.
      const moved = [...paramKeys].some((paramKey) => {
        const rich = priceOnBoard({ primitive, params: { [paramKey]: RICH_BODY } });
        const empty = priceOnBoard({ primitive, params: { [paramKey]: [] } });
        return rich !== empty;
      });
      if (!moved) {
        flat.push(
          `${primitive} (e.g. ${example}): no body param [${[...paramKeys].join(', ')}] changes the price`,
        );
      }
    }
    expect(
      flat,
      'wrapper primitives whose value IGNORES the nested body — the exact §3.42 failure shape',
    ).toEqual([]);
  });
});
