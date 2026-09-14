/**
 * §3.143 / UX-6 + UX-7 — "you may &lt;do X to&gt; target Y" is asked MAY-FIRST, for
 * the whole CLASS, and the answer survives the priority round.
 *
 * Three kinds of test live here, and the second and third are the ones that
 * matter:
 *
 * 1. **Unit rules** for the table, the scan and the ledger.
 * 2. **A POOL SWEEP** (`the real pool`) that re-measures the class on every run
 *    — 5,651 cards, every ability source, every depth — and fails if a card with
 *    a tabulated gate plus targets would still be asked in the wrong order. This
 *    is the guard rule 10 demands: the previous fix was a predicate over
 *    `def.triggers` with no sweep behind it, so nothing could see the day it
 *    stopped matching.
 * 3. **A REAL-ENGINE probe** (`the engine parks the may a priority round
 *    later`) that pins the delivery bug the previous version shipped: it
 *    answered the target and then read `pendingChoice` SYNCHRONOUSLY, on a
 *    comment asserting the follow-up was already there. It is not. That test
 *    fails without {@link matchDeferredMay}.
 *
 * The pool reads are DATA, not invention: the first assertions go through the
 * real Conjurer's Closet, so a rename in the cards package cannot silently
 * switch this rule off (TESTING.md rule 1 — a test that invents an id proves
 * nothing).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  createGame,
  defaultAnswerFor,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type InstanceId,
  type PendingChoice,
  type PlayerId,
} from '@jonny-boi/core';
import { GameSession } from './session.js';
import {
  abilitySourcesOf,
  ABILITY_SOURCE_KINDS,
  CARD_DEFINITION_FIELD_SCAN,
  consumeDeferredMay,
  EMPTY_MAY_LEDGER,
  expireDeferredMay,
  findOptionalGates,
  foldedMayPrompt,
  isTabulatedGate,
  matchDeferredMay,
  OPTIONAL_GATE_SHAPES,
  recordDeferredMay,
  type AbilitySource,
  type DeferredMayLedger,
} from './optional-trigger.js';

const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();
const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

const CLOSET = card("Conjurer's Closet");

function targetChoice(over: Partial<PendingChoice> = {}): PendingChoice {
  return {
    kind: 'selectTargets',
    id: 1,
    chooser: 'A',
    prompt: 'Choose a creature you control for your end step: you may exile target creature you control',
    valence: 'gain',
    sourceInstanceId: 30,
    sourceName: "Conjurer's Closet",
    min: 1,
    max: 1,
    candidates: [{ ref: 12, name: 'Elvish Visionary', controller: 'A' }],
    restriction: 'creatureYouControl',
    ...over,
  } as PendingChoice;
}

// ---------------------------------------------------------------------------
// The table is CLOSED, and its closure is derived rather than remembered
// ---------------------------------------------------------------------------

/** The three calls a cards primitive makes when it stops the game to ask. */
const ASK_CALLS = ['ctx.confirm(', 'ctx.payOrDecline(', 'ctx.payLifeOrDecline('] as const;
const PRIMITIVE_DECLARATION = /export const ([A-Za-z0-9_]+)\s*:\s*EffectPrimitive\s*=/g;

/**
 * Every primitive in `@jonny-boi/cards` that asks, scanned out of the SOURCE.
 *
 * Three of the sixteen (`riotChoice`, `unleashChoice`, `payLifeOrElse`) are
 * reached by NO card in today's pool and would have been invisible to any
 * pool-based audit — which is exactly why the vocabulary is derived from the
 * primitives rather than from what the pool happens to use.
 */
function askingPrimitives(): ReadonlySet<string> {
  const dir = fileURLToPath(new URL('../../../../../packages/cards/src/', import.meta.url));
  const found = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    // CRLF trap (CLAUDE.md): committed sources are CRLF on a Windows checkout.
    const text = readFileSync(`${dir}${file}`, 'utf8').replace(/\r\n/g, '\n');
    const declarations = [...text.matchAll(PRIMITIVE_DECLARATION)].map((m) => ({
      name: m[1] as string,
      at: m.index as number,
    }));
    for (let i = 0; i < declarations.length; i++) {
      const start = (declarations[i] as { at: number }).at;
      const next = declarations[i + 1];
      const body = text.slice(start, next ? next.at : text.length);
      if (ASK_CALLS.some((call) => body.includes(call))) found.add((declarations[i] as { name: string }).name);
    }
  }
  return found;
}

describe('OPTIONAL_GATE_SHAPES is a closed table over what the cards package actually asks', () => {
  const asking = askingPrimitives();

  it('found the asking primitives by scanning the primitive source, not by memory', () => {
    // A scan that finds nothing would make every assertion below vacuous.
    expect(asking.size).toBe(16);
    expect(asking.has('mayEffects')).toBe(true);
  });

  it('every asking primitive has a row — a new one stops this test, not the player', () => {
    const missing = [...asking].filter((name) => !isTabulatedGate(name)).sort();
    expect(missing).toEqual([]);
  });

  it('every row names a primitive that still asks — a stale row is a lie too', () => {
    const stale = Object.keys(OPTIONAL_GATE_SHAPES).filter((name) => !asking.has(name)).sort();
    expect(stale).toEqual([]);
  });

  it('every row states WHY it has the semantics it has', () => {
    for (const [name, shape] of Object.entries(OPTIONAL_GATE_SHAPES)) {
      expect(shape.why.length, `${name} must justify its semantics`).toBeGreaterThan(30);
    }
  });

  it('only "may" rows can ever be folded — "unless" and "mode" have real stakes', () => {
    // A decline that counters your spell (ward), kills you (a Pact) or picks the
    // other half of riot is not "don't do it at all", and must never be offered
    // as one.
    expect(OPTIONAL_GATE_SHAPES['wardCounterUnlessPaid']?.semantics).toBe('unless');
    expect(OPTIONAL_GATE_SHAPES['riotChoice']?.semantics).toBe('mode');
    expect(OPTIONAL_GATE_SHAPES['mayEffects']?.semantics).toBe('may');
  });
});

describe('the scan looks at EVERY ability source, not just def.triggers', () => {
  it('classifies every field of core CardDefinition — the compile-time guard, re-checked at runtime', () => {
    // The mapped type over `keyof Required<CardDefinition>` already fails `tsc`
    // on an unclassified field, but Vitest strips types, so the same claim is
    // re-derived here from core's source: on this box the type-check and the
    // test do not always run together.
    const source = readFileSync(
      fileURLToPath(new URL('../../../../../packages/core/src/card.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const start = source.indexOf('export interface CardDefinition {');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf('\n}', start));
    const fields = [...body.matchAll(/^ {2}readonly ([A-Za-z0-9_]+)\??:/gm)].map((m) => m[1] as string);
    expect(fields.length).toBeGreaterThan(60);
    expect([...fields].sort()).toEqual(Object.keys(CARD_DEFINITION_FIELD_SCAN).sort());
  });

  it('enumerates a trigger, an activated ability and a spell script from the same card shape', () => {
    const kinds = new Set<string>();
    for (const def of pool.cards) for (const source of abilitySourcesOf(def)) kinds.add(source.kind);
    // Every kind the enumeration declares must be reachable from the real pool,
    // or the vocabulary is describing cards that do not exist.
    const unreached = ABILITY_SOURCE_KINDS.filter((kind) => !kinds.has(kind));
    expect(unreached).toEqual(['castTrigger', 'graveyardAbility', 'alternativeCostRider']);
  });

  it('memoises per definition — this runs inside a render pass', () => {
    expect(abilitySourcesOf(CLOSET)).toBe(abilitySourcesOf(CLOSET));
    expect(abilitySourcesOf(undefined)).toEqual([]);
  });

  it('finds a gate nested below the top level, which the old predicate could not', () => {
    // Synthetic on purpose: MEASURED, no pool card nests a gate today (see the
    // sweep). The recursion exists so the day one does, it is seen — "it happens
    // to be flat" is the assumption the previous version encoded.
    const nested = findOptionalGates(
      [{ primitive: 'ifCondition', params: { then: [{ primitive: 'mayEffects', params: { effects: [] } }] } }],
      undefined,
    );
    expect(nested).toHaveLength(1);
    expect(nested[0]?.depth).toBe(1);
  });

  it('an untabulated primitive is not a gate — the table REPORTS rather than widens', () => {
    expect(findOptionalGates([{ primitive: 'notAPrimitiveWeKnow', params: {} }], undefined)).toEqual([]);
  });

  it('a searchLibrary without `optional: true` is a mandatory search, not a question', () => {
    expect(findOptionalGates([{ primitive: 'searchLibrary', params: {} }], undefined)).toEqual([]);
    expect(findOptionalGates([{ primitive: 'searchLibrary', params: { optional: true } }], undefined)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE SWEEP — the measurement, re-run on every test run (rule 11)
// ---------------------------------------------------------------------------

/** One gate instance in the pool, with everything the class question needs. */
interface SweepRow {
  readonly cardName: string;
  readonly source: AbilitySource;
  readonly primitive: string;
  readonly depth: number;
  readonly semantics: string;
  readonly gatesTheTarget: boolean;
}

function sweep(): readonly SweepRow[] {
  const rows: SweepRow[] = [];
  for (const def of pool.cards) {
    for (const source of abilitySourcesOf(def)) {
      for (const gate of findOptionalGates(source.effects, source.targets)) {
        rows.push({
          cardName: def.name,
          source,
          primitive: gate.primitive,
          depth: gate.depth,
          semantics: gate.shape.semantics,
          gatesTheTarget: gate.gatesTheTarget,
        });
      }
    }
  }
  return rows;
}

describe('the real pool — the measurement, and the guard that it stays true', () => {
  const rows = sweep();
  const mays = rows.filter((r) => r.semantics === 'may');
  /** The UX-6 class: the source aims, and the gate's body is what consumes the aim. */
  const klass = mays.filter((r) => r.gatesTheTarget && r.source.targetMin > 0);

  it('measures a pool worth measuring', () => {
    expect(pool.cards.length).toBeGreaterThan(5000);
    expect(rows.length).toBeGreaterThan(100);
  });

  it('THE NUMBER: 24 cards print "you may <do X to> target Y" — all triggers, all at depth 0', () => {
    // Reported honestly, and it is SMALLER than the headline that motivated the
    // work: the previous narrow rule missed NONE of these. UX-6 was not a
    // coverage gap, it was a delivery bug (see the engine probe below) plus this
    // class-shaped generalisation, which is what stops the coverage gap from
    // opening the first time a card lands outside `def.triggers`.
    expect(new Set(klass.map((r) => r.cardName)).size).toBe(24);
    expect(new Set(klass.map((r) => r.source.kind))).toEqual(new Set(['trigger']));
    expect(new Set(klass.map((r) => r.depth))).toEqual(new Set([0]));
    expect(new Set(klass.map((r) => r.primitive))).toEqual(new Set(['mayEffects']));
    expect(klass.map((r) => r.cardName)).toContain("Conjurer's Closet");
    expect(klass.map((r) => r.cardName)).toContain('Aura Shards');
  });

  it('EVERY card in the class folds — this is the "asked in the wrong order" guard', () => {
    // The claim in words: for every pool card whose printed shape is
    // "you may <do X to> target Y", a target question raised by that source
    // produces a folded MAY-FIRST prompt. A card that stopped folding — because
    // the compiler renamed a primitive, or grew a second gate, or moved the aim
    // — fails here by name.
    const notFolding: string[] = [];
    for (const row of klass) {
      const def = pool.getByName(row.cardName) as CardDefinition;
      const choice = targetChoice({
        sourceName: def.name,
        restriction: row.source.targets,
        min: row.source.targetMin,
      } as Partial<PendingChoice>);
      if (foldedMayPrompt(choice, def) === null) notFolding.push(def.name);
    }
    expect(notFolding).toEqual([]);
  });

  it('no gate hides below the top level today, and none has a min-0 target', () => {
    expect(rows.filter((r) => r.depth > 0)).toEqual([]);
    // Pinned at zero on purpose: `foldedMayPrompt` excludes `min === 0` because
    // "choose none" for "up to three target creatures" still RESOLVES the may,
    // which is a different answer from declining it. If the pool ever grows one,
    // this fails and somebody re-decides rather than inheriting the exclusion.
    expect(mays.filter((r) => r.gatesTheTarget && r.source.targetMin === 0)).toEqual([]);
  });

  it('a RIDER is never folded — its "may" is a separate printed sentence', () => {
    // Incinerating Blast: "Deal 6 damage to target creature. You may discard a
    // card. If you do, draw a card." A predicate of "source targets AND source
    // has a may" folds this wrongly and suppresses a question the player must
    // answer. Path to Exile is the same shape, and its may belongs to the
    // OPPONENT.
    const blast = card('Incinerating Blast');
    const riderRows = rows.filter((r) => r.cardName === blast.name);
    expect(riderRows.length).toBeGreaterThan(0);
    expect(riderRows.every((r) => !r.gatesTheTarget)).toBe(true);
    expect(foldedMayPrompt(targetChoice({ sourceName: blast.name, restriction: 'creature' } as Partial<PendingChoice>), blast)).toBeNull();
    expect(foldedMayPrompt(targetChoice({ sourceName: 'Path to Exile', restriction: 'creature' } as Partial<PendingChoice>), card('Path to Exile'))).toBeNull();
  });

  it('no pool card is AMBIGUOUS — two target-gating mays on one source would REFUSE', () => {
    const perSource = new Map<AbilitySource, number>();
    for (const row of klass) perSource.set(row.source, (perSource.get(row.source) ?? 0) + 1);
    expect([...perSource.values()].filter((n) => n > 1)).toEqual([]);
  });

  it('offers no fold on a card with no may at all', () => {
    expect(foldedMayPrompt(targetChoice(), card('Thragtusk'))).toBeNull();
    expect(foldedMayPrompt(targetChoice(), undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The folded prompt
// ---------------------------------------------------------------------------

describe('foldedMayPrompt', () => {
  it('leads with the card’s OWN printed "you may" wording, not invented copy', () => {
    const fold = foldedMayPrompt(targetChoice(), CLOSET);
    expect(fold).not.toBeNull();
    expect(fold?.mayPrompt).toBe(
      'You may exile target creature you control, then return that card to the battlefield under your control',
    );
    expect(fold?.acceptLabel).toBe(`Yes — use ${CLOSET.name}`);
    expect(fold?.declineLabel).toBe(`No — don’t use ${CLOSET.name}`);
    expect(fold?.sourceKind).toBe('trigger');
    expect(fold?.primitive).toBe('mayEffects');
  });

  it('offers nothing on an "up to" choice, which already has its own decline', () => {
    expect(foldedMayPrompt(targetChoice({ min: 0 }), CLOSET)).toBeNull();
  });

  it('offers nothing on a question that is not about targets', () => {
    expect(foldedMayPrompt({ ...targetChoice(), kind: 'confirm' } as PendingChoice, CLOSET)).toBeNull();
  });

  it('offers nothing when the parked question aims at something the may does not gate', () => {
    // Same card, different restriction: the fold must match the SOURCE that is
    // actually being aimed, not merely "this card has a may somewhere".
    expect(foldedMayPrompt(targetChoice({ restriction: 'artifact' } as Partial<PendingChoice>), CLOSET)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The deferred-may ledger
// ---------------------------------------------------------------------------

const TURN = 5;
const CLOSET_INSTANCE: InstanceId = 30;

function confirmFrom(sourceInstanceId: InstanceId): PendingChoice {
  return { ...targetChoice(), kind: 'confirm', id: 2, sourceInstanceId } as PendingChoice;
}

describe('the deferred-may ledger', () => {
  const ledger: DeferredMayLedger = recordDeferredMay(EMPTY_MAY_LEDGER, {
    sourceInstanceId: CLOSET_INSTANCE,
    targets: [12],
    yes: false,
    turnNumber: TURN,
  });

  it('settles the confirm that belongs to the trigger the player answered', () => {
    const hit = matchDeferredMay(ledger, confirmFrom(CLOSET_INSTANCE), {
      sourceInstanceId: CLOSET_INSTANCE,
      targets: [12],
    });
    expect(hit).toEqual({ index: 0, yes: false });
    expect(consumeDeferredMay(ledger, 0)).toEqual([]);
  });

  it('REFUSES when there is no resolution frame — the online board’s masked view', () => {
    // `PendingChoice` carries the source PERMANENT, never the stack object, so
    // the frame is the only honest pairing handle. No frame, no answer: asking
    // the player again beats answering the wrong trigger.
    expect(matchDeferredMay(ledger, confirmFrom(CLOSET_INSTANCE), null)).toBeNull();
    expect(matchDeferredMay(ledger, confirmFrom(CLOSET_INSTANCE), {})).toBeNull();
  });

  it('does not answer another permanent’s question', () => {
    expect(matchDeferredMay(ledger, confirmFrom(99), { sourceInstanceId: 99, targets: [12] })).toBeNull();
  });

  it('does not answer a question about DIFFERENT targets from the same permanent', () => {
    expect(
      matchDeferredMay(ledger, confirmFrom(CLOSET_INSTANCE), { sourceInstanceId: CLOSET_INSTANCE, targets: [77] }),
    ).toBeNull();
  });

  it('pairs two triggers from ONE permanent in reverse order — the Aura Shards case', () => {
    // Two creatures entering together put TWO Aura Shards triggers on the stack.
    // The engine AIMS them from the bottom of the stack up (`aimPendingTriggers`
    // takes the lowest `awaitingTargets` index) and RESOLVES from the top down
    // (`stack.pop()`), so answers pair in reverse. A source-keyed FIFO would
    // apply the first trigger's decline to the second trigger's may.
    let two = recordDeferredMay(EMPTY_MAY_LEDGER, {
      sourceInstanceId: CLOSET_INSTANCE,
      targets: [12],
      yes: false,
      turnNumber: TURN,
    });
    two = recordDeferredMay(two, {
      sourceInstanceId: CLOSET_INSTANCE,
      targets: [13],
      yes: true,
      turnNumber: TURN,
    });
    const first = matchDeferredMay(two, confirmFrom(CLOSET_INSTANCE), {
      sourceInstanceId: CLOSET_INSTANCE,
      targets: [13],
    });
    expect(first).toEqual({ index: 1, yes: true });
    const rest = consumeDeferredMay(two, 1);
    expect(
      matchDeferredMay(rest, confirmFrom(CLOSET_INSTANCE), { sourceInstanceId: CLOSET_INSTANCE, targets: [12] }),
    ).toEqual({ index: 0, yes: false });
  });

  it('takes the LAST recorded when two entries are otherwise identical', () => {
    let two = recordDeferredMay(EMPTY_MAY_LEDGER, {
      sourceInstanceId: CLOSET_INSTANCE,
      targets: [12],
      yes: true,
      turnNumber: TURN,
    });
    two = recordDeferredMay(two, {
      sourceInstanceId: CLOSET_INSTANCE,
      targets: [12],
      yes: false,
      turnNumber: TURN,
    });
    expect(matchDeferredMay(two, confirmFrom(CLOSET_INSTANCE), {
      sourceInstanceId: CLOSET_INSTANCE,
      targets: [12],
    })).toEqual({ index: 1, yes: false });
  });

  it('never outlives its turn — a trigger removed from the stack never asks', () => {
    expect(expireDeferredMay(ledger, TURN)).toBe(ledger); // no copy when nothing expires
    expect(expireDeferredMay(ledger, TURN + 1)).toEqual([]);
  });

  it('an out-of-range consume is a no-op rather than a corrupted ledger', () => {
    expect(consumeDeferredMay(ledger, -1)).toBe(ledger);
    expect(consumeDeferredMay(ledger, 9)).toBe(ledger);
  });
});

// ---------------------------------------------------------------------------
// The real engine — the delivery bug, pinned
// ---------------------------------------------------------------------------

/** Build the reported board: a Conjurer's Closet and three creatures. */
function closetBoard(): { session: GameSession; closet: CardInstance } {
  const forest = card('Forest');
  const created = createGame({
    seed: 77,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  });
  const state: GameState = created.state;
  state.players.A.hand = [];
  state.players.B.hand = [];
  const place = (def: CardDefinition, controller: PlayerId): CardInstance => {
    const inst: CardInstance = {
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
    state.battlefield.push(inst);
    return inst;
  };
  const closet = place(CLOSET, 'A');
  // THREE creatures, exactly as the reporter's board had. With only ONE legal
  // target the engine auto-answers the target question as trivial, so a
  // one-creature fixture would prove nothing about the pair of prompts.
  for (const name of ['Elvish Visionary', "Avacyn's Pilgrim", 'Gatecreeper Vine']) place(card(name), 'A');
  return { session: GameSession.fromCreated(created, registry, NAMES), closet };
}

/** Walk priority until a question is parked (or the walk gives up). */
function walkToChoice(from: GameSession): GameSession {
  let session = from;
  for (let guard = 0; guard < 200; guard++) {
    if (session.pendingChoice || session.gameOver) return session;
    const next = session.passPriority();
    if (next.rejected) return session;
    session = next.session;
  }
  return session;
}

describe('the engine parks the may a priority round later — the bug the fold shipped with', () => {
  it('answering the target leaves NO pending choice, so a synchronous fold cannot fire', () => {
    const aimed = walkToChoice(closetBoard().session);
    const first = aimed.pendingChoice;
    expect(first?.kind).toBe('selectTargets');
    expect(foldedMayPrompt(first as PendingChoice, CLOSET)).not.toBeNull();

    const answered = aimed.answerChoice(defaultAnswerFor(first as PendingChoice));
    expect(answered.rejected).toBeNull();

    // ⚠️ THE DEFECT, pinned: the previous `declineOptionalTrigger` read exactly
    // this value and folded on it. It is null — the trigger is on the stack and
    // needs a full priority round before it resolves and asks — so the "may"
    // was never answered and the second modal appeared anyway, on all 24 cards
    // of the class, every time.
    expect(answered.session.pendingChoice).toBeNull();
  });

  it('the ledger answer survives the round and settles the may with no second modal', () => {
    const { session, closet } = closetBoard();
    const aimed = walkToChoice(session);
    const first = aimed.pendingChoice as PendingChoice;
    const answer = defaultAnswerFor(first);
    const targets = answer.kind === 'selectTargets' ? answer.targets : [];

    const answered = aimed.answerChoice(answer);
    expect(answered.rejected).toBeNull();
    const ledger = recordDeferredMay(EMPTY_MAY_LEDGER, {
      sourceInstanceId: first.sourceInstanceId,
      targets: [...targets],
      yes: false,
      turnNumber: answered.session.state.turnNumber,
    });

    const resolving = walkToChoice(answered.session);
    const may = resolving.pendingChoice;
    expect(may?.kind).toBe('confirm');
    expect(may?.sourceInstanceId).toBe(closet.instanceId);

    // The engine's own bookmark is what pairs the confirm with the trigger.
    const frame = resolving.state.resolution;
    expect(frame?.origin).toBe('trigger');
    expect(frame?.sourceInstanceId).toBe(closet.instanceId);

    const hit = matchDeferredMay(ledger, may as PendingChoice, frame ?? null);
    expect(hit).not.toBeNull();
    expect(hit?.yes).toBe(false);

    // Answering it NO finishes the trigger with nothing exiled — the player was
    // asked once, and the board never showed a second modal.
    const settled = resolving.answerChoice({ kind: 'confirm', yes: hit?.yes === true });
    expect(settled.rejected).toBeNull();
    expect(settled.session.state.battlefield.some((p) => p.instanceId === closet.instanceId)).toBe(true);
  });
});
