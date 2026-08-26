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
  addCounters: 'x19 in pool — a +1/+1-counter payoff is invisible when aiming or choosing modes',
  attachToTarget: 'x42 in pool — an Equip/attach effect scores flat (bestEquipPlay prices the PLAY, not this ref)',
  chooseAsEnters: 'x6 in pool — the named-value choice body is not priced',
  createEmblem: 'unreachable from pool refs today; an emblem would score flat',
  dealDamageToEach: 'x4 in pool — a sweeper scores flat, blind to what it would kill',
  exileUntilLeaves: 'x3 in pool — an O-Ring scores flat, blind to what it would jail',
  fight: 'unreachable from pool refs today; a fight would score flat, blind to both bodies',
  gainControl: 'x2 in pool — a theft scores flat, blind to what it would steal',
  grantKeywordToYoursUntilEndOfTurn: 'x1 in pool — a team keyword grant scores flat',
  handToBottomThenDraw: 'x1 in pool — a wheel-half scores flat',
  ifKicked: 'x3 in pool — a WRAPPER: the kicked body is never read, so a kicker payoff is invisible',
  mill: 'x6 in pool — milling scores flat, blind to how deep',
  persistReturn: 'x1 in pool — the persist return is not priced when weighing removal against it',
  returnChosenToHand: 'unreachable from pool refs today',
  returnExiledByThis: 'x3 in pool — the O-Ring release half; scores flat',
  scry: 'x29 in pool — the pool’s most common unpriced effect; scry N scores flat for every N',
  surveil: 'x13 in pool — same blindness as scry',
  transformRevealTop: 'x1 in pool — the reveal-and-transform body scores flat',
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
    const wrappers = new Map<string, { paramKey: string; example: string }>();
    for (const card of CARD_POOL) {
      walkCardRefs(card, (ref, path) => {
        for (const key of nestedRefParams(ref)) {
          if (!wrappers.has(ref.primitive)) wrappers.set(ref.primitive, { paramKey: key, example: path });
        }
      });
    }
    expect(wrappers.size, 'the pool carries wrapper primitives; discovery finding none is itself a failure').toBeGreaterThan(0);

    const flat: string[] = [];
    for (const [primitive, { paramKey, example }] of wrappers) {
      if (KNOWN_UNPRICED[primitive] !== undefined) continue; // carried openly, checked above
      const rich = priceOnBoard({ primitive, params: { [paramKey]: RICH_BODY } });
      const empty = priceOnBoard({ primitive, params: { [paramKey]: [] } });
      if (rich === empty) flat.push(`${primitive} (e.g. ${example}): rich body and empty body both price ${rich}`);
    }
    expect(
      flat,
      'wrapper primitives whose value IGNORES the nested body — the exact §3.42 failure shape',
    ).toEqual([]);
  });
});
