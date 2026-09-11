/**
 * THE DAMAGE-DISTRIBUTION SEQUENCE (pure, DOM-free, unit-tested) — UX-15 of the
 * MTGA-parity overhaul (§3.143). Caleb: *"Animations when block phase is over and
 * damage is being distributed to players and creatures, just like MTGA does it,
 * so you can clearly see what's happening."*
 *
 * Same shape as its two siblings, `animations.ts` and `vfx-cues.ts`: game events
 * in, a plan of beats out, decided HERE where a test can pin it. The DOM half
 * (`DamageLayer`, in `AnimationLayer.tsx`) only measures rects and schedules —
 * WHAT hits, in WHAT order, from WHERE to WHERE, and WHEN, is decided in this
 * file. Nothing is stored: a derived value cannot go stale, and a replay
 * re-derives the identical sequence from the identical log.
 *
 * ## Rounds — why a fold has to find them, and exactly how
 * A combat with a first-striker is TWO damage steps (CR 510.4), and the brief is
 * that they must read as two rounds rather than one blur. The engine runs them as
 * two calls to `assignAndDealCombatDamage` with a state-based-action check
 * between — but **it emits no marker saying which round a hit belonged to**, so
 * this fold has to recover the boundary. It does that from two facts about the
 * RULES, never from the engine's loop order (which is an implementation detail
 * this layer must not couple to):
 *
 *  1. **All damage in one step is dealt simultaneously** (CR 510.2). So one
 *     source cannot deal damage to the same recipient twice in one round —
 *     seeing that pair a second time means a second round has begun. This is
 *     exactly how double strike shows up (CR 702.4b), which is the commonest
 *     reason two rounds exist at all. Note the pair, not the source: a trampler
 *     hits its blocker AND the defending player in ONE round, and an attacker
 *     blocked by three creatures deals to all three in one round.
 *  2. **Nothing dies mid-step.** Deaths are state-based actions between steps, so
 *     any `creatureDied` / `planeswalkerDied` / `battleDefeated` / `playerLost`
 *     ends the round it follows — and attributes LETHALITY to it, which is how a
 *     lethal hit gets to read differently from a survivable one without this
 *     layer re-deriving toughness that core already knows.
 *
 * Everything else is a CLOSED TABLE with an honest default:
 * {@link DAMAGE_ROUND_COMPANIONS} lists the event types the engine emits *inside*
 * one damage assignment (the life loss, the lifelink gain, the poison, the
 * loyalty/defense tick, the -1/-1 counters, a replacement firing). Anything not
 * in that table ends the round. The default is deliberately the SAFE direction:
 * an unknown event splits one round into two, which shows more rounds than there
 * were — the failure mode the other way round is the "one blur" the brief
 * forbids.
 *
 * ⚠️ **The one case this cannot see, stated honestly:** a first-strike round that
 * kills nothing, contains no double-striker and shares no source/recipient pair
 * with the normal round is indistinguishable from one round in the event log.
 * Its hits still animate, staggered and individually legible; what is lost is the
 * beat between the rounds. The real fix is one field in core — a `round` on
 * `damageDealt`, or a `combatDamageStep` marker event — and the day it exists
 * this fold should read it and delete rule 1 above. `damage-sequence.test.ts`
 * pins the blind spot so it cannot be quietly forgotten.
 *
 * ## The cap, and what "condensed" means
 * A twenty-creature combat must not stall the game, and it must not silently drop
 * hits either. So the plan degrades instead of truncating: a round that does not
 * fit the budget is presented CONDENSED — one bloom per RECIPIENT carrying the
 * total it took, all at once, no travel. That is bounded by construction (one
 * impact plus the settle beat, however big the combat), every point of damage is
 * still accounted for on screen, and the whole sequence is provably no longer
 * than `maxTotalMs + impactMs + settleHoldMs` (see {@link sequenceDurationMs},
 * which the test pins against a 40-round, 200-hit input).
 *
 * ## Reduced motion
 * Honored at the SOURCE, like both siblings: `reducedMotion` derives nothing at
 * all, so not one element is ever mounted. The life totals, the log and the board
 * carry the same facts without motion.
 */
import type { GameEvent, InstanceId, PlayerId } from '@jonny-boi/core';
import { DAMAGE_ANIM_CONFIG } from './play-config.js';

/** Where one end of a hit is — a permanent's tile, or a player's seat. */
export type DamageEnd =
  | { readonly where: 'tile'; readonly instanceId: InstanceId }
  | { readonly where: 'seat'; readonly seat: PlayerId };

/**
 * How a beat is presented. `hit` travels from its source to its recipient;
 * `condensed` blooms at the recipient with the round's total and no travel,
 * because too many hits to follow is a different thing to show, not a smaller
 * version of the same thing.
 */
export type DamageBeatKind = 'hit' | 'condensed';

/** Did the damage land, or was it prevented before it landed (a shield, a fog)? */
export type DamageOutcome = 'dealt' | 'prevented';

/** One beat of the sequence: something hit something, at a known moment. */
export interface DamageBeat {
  /** Stable, unique React key, minted from the ABSOLUTE event index. */
  readonly key: string;
  readonly kind: DamageBeatKind;
  /**
   * Which damage round this belongs to, 0-based. A first-strike combat produces
   * beats with `roundIndex` 0 and 1; the gap between them is
   * `DAMAGE_ANIM_CONFIG.settleHoldMs`.
   */
  readonly roundIndex: number;
  /** The source's tile. `null` on a condensed beat — it has many sources. */
  readonly from: DamageEnd | null;
  readonly to: DamageEnd;
  /** Damage dealt (or, on a `prevented` beat, damage prevented). Always > 0. */
  readonly amount: number;
  readonly outcome: DamageOutcome;
  /** Combat damage, as opposed to a burn spell or a fight. */
  readonly combat: boolean;
  /**
   * The recipient died from this round's damage (or, for a seat, lost the game).
   * Read from the engine's own death events, never re-derived from toughness.
   */
  readonly lethal: boolean;
  /** When this beat starts, ms from the start of the sequence. */
  readonly startMs: number;
  /** Travel time for this beat. 0 on a condensed beat (it does not travel). */
  readonly travelMs: number;
  /** How long the impact blooms once it arrives. */
  readonly impactMs: number;
}

/** What {@link deriveDamageSequence} needs beside the events. */
export interface DeriveDamageOptions {
  /** The user asked for reduced motion — derive nothing at all. */
  readonly reducedMotion: boolean;
  /** Absolute index of `events[0]` in the full log, so keys never collide. */
  readonly startIndex: number;
}

/** Shared empty result so a quiet frame (the overwhelming majority) allocates nothing. */
const NO_BEATS: readonly DamageBeat[] = Object.freeze([]);

/**
 * THE COMPANION TABLE — event types the engine emits *within* a single
 * simultaneous damage assignment, which therefore do NOT end a damage round.
 *
 * Every row is a real emission site in `internal/damage-result.ts` /
 * `internal/combat.ts` / `internal/replacement.ts`, not a guess:
 * life loss and the lifelink gain, poison from infect/toxic, a planeswalker's
 * loyalty or a battle's defense ticking down, infect's -1/-1 counters, and a
 * replacement effect (a damage doubler, a prevention shield) firing mid-hit.
 *
 * ⚠️ CLOSED, with the safe default: an event type NOT listed here ends the round.
 * Widening it to "anything that looks harmless" is how two rounds become one
 * blur, and a spurious extra round is the cheaper mistake.
 */
const DAMAGE_ROUND_COMPANIONS: Partial<Record<GameEvent['type'], true>> = Object.freeze({
  damageDealt: true,
  damagePrevented: true,
  lifeChanged: true,
  gainLife: true,
  poisonChanged: true,
  loyaltyChanged: true,
  defenseChanged: true,
  counterAdded: true,
  replacementApplied: true,
});

/**
 * THE DEATH TABLE — what each "something left the game" event says DIED, so the
 * round it follows can mark the beats that killed it.
 *
 * A row returns the {@link DamageEnd} key of the thing that died; a beat is
 * lethal only when its own recipient matches, which is what keeps an unrelated
 * later death (a -X/-X spell two events after combat) from painting an earlier
 * hit red.
 */
const DEATH_SUBJECT: Partial<Record<GameEvent['type'], (event: GameEvent) => string | undefined>> = Object.freeze({
  creatureDied: (e) => (e.type === 'creatureDied' ? tileKey(e.instanceId) : undefined),
  planeswalkerDied: (e) => (e.type === 'planeswalkerDied' ? tileKey(e.instanceId) : undefined),
  battleDefeated: (e) => (e.type === 'battleDefeated' ? tileKey(e.instanceId) : undefined),
  playerLost: (e) => (e.type === 'playerLost' ? seatKey(e.player) : undefined),
});

/** Identity of a tile end, as a string so ends can key a Map/Set. */
function tileKey(id: InstanceId): string {
  return `tile:${id}`;
}

/** Identity of a seat end (see {@link tileKey}). */
function seatKey(seat: PlayerId): string {
  return `seat:${seat}`;
}

/** A tile end, narrowed: the SOURCE of damage is always a permanent. */
type TileEnd = Extract<DamageEnd, { where: 'tile' }>;

/** One damage event, normalized to ends the layer can measure. */
interface Hit {
  /** Absolute index in the session's log — the beat's key comes from this. */
  readonly eventIndex: number;
  readonly from: TileEnd;
  readonly to: DamageEnd;
  readonly toKey: string;
  readonly amount: number;
  readonly outcome: DamageOutcome;
  readonly combat: boolean;
}

/** One damage round: hits dealt simultaneously, plus what died right after them. */
interface Round {
  readonly hits: Hit[];
  /** `source→recipient:outcome` triples already seen — a repeat means a new round. */
  readonly pairs: Set<string>;
  /** Ends that died after this round (see {@link DEATH_SUBJECT}). */
  readonly died: Set<string>;
  /** An event that cannot occur inside a damage step has been seen since. */
  sealed: boolean;
}

/** Normalize a `damageDealt`/`damagePrevented` event into a {@link Hit}. */
function hitOf(event: GameEvent, eventIndex: number): Hit | undefined {
  if (event.type !== 'damageDealt' && event.type !== 'damagePrevented') return undefined;
  // A zero-or-negative hit is not a thing that happened; showing "0" would be a
  // lie about a shield that ate the whole swing (that is a `damagePrevented`).
  if (event.amount <= 0) return undefined;
  const to: DamageEnd =
    typeof event.target === 'number' ? { where: 'tile', instanceId: event.target } : { where: 'seat', seat: event.target };
  return {
    eventIndex,
    from: { where: 'tile', instanceId: event.source },
    to,
    toKey: typeof event.target === 'number' ? tileKey(event.target) : seatKey(event.target),
    amount: event.amount,
    outcome: event.type === 'damageDealt' ? 'dealt' : 'prevented',
    combat: event.combat,
  };
}

/** Split a batch into damage rounds (see the module doc for the two rules). */
function roundsIn(events: readonly GameEvent[], startIndex: number): Round[] {
  const rounds: Round[] = [];
  let current: Round | undefined;
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as GameEvent;
    const hit = hitOf(event, startIndex + i);
    if (hit !== undefined) {
      const pair = `${hit.from.instanceId}>${hit.toKey}:${hit.outcome}`;
      if (current === undefined || current.sealed || current.pairs.has(pair)) {
        current = { hits: [], pairs: new Set(), died: new Set(), sealed: false };
        rounds.push(current);
      }
      current.pairs.add(pair);
      current.hits.push(hit);
      continue;
    }
    const subject = DEATH_SUBJECT[event.type];
    if (subject !== undefined) {
      // A death both ATTRIBUTES to the round it follows and ends it: state-based
      // actions run between damage steps, never inside one.
      const key = subject(event);
      if (current !== undefined) {
        if (key !== undefined) current.died.add(key);
        current.sealed = true;
      }
      continue;
    }
    // Not a hit, not a death, not tabulated as a companion ⇒ the round is over.
    // `sealed` rather than `current = undefined` so a death arriving AFTER an
    // intervening event still attributes: a damage spell emits `stackResolved`
    // between its damage and the state-based action that kills the target.
    if (DAMAGE_ROUND_COMPANIONS[event.type] === undefined && current !== undefined) current.sealed = true;
  }
  return rounds;
}

/** How long a round of `hitCount` individually-animated hits occupies. */
function fullRoundMs(hitCount: number): number {
  const { travelMs, impactMs, staggerMs, settleHoldMs } = DAMAGE_ANIM_CONFIG;
  return (hitCount - 1) * staggerMs + travelMs + impactMs + settleHoldMs;
}

/**
 * How long a CONDENSED round occupies — constant, whatever the combat's size.
 * That constancy is the whole point of the degradation: it is what makes the cap
 * a real bound rather than an aspiration.
 */
function condensedRoundMs(): number {
  return DAMAGE_ANIM_CONFIG.impactMs + DAMAGE_ANIM_CONFIG.settleHoldMs;
}

/** One recipient's share of a condensed round. */
interface CondensedShare {
  readonly to: DamageEnd;
  readonly toKey: string;
  dealt: number;
  prevented: number;
  combat: boolean;
  /** The earliest event index that fed this share — the key is minted from it. */
  readonly firstEventIndex: number;
}

/** Sum a set of rounds per RECIPIENT, in first-seen order. */
function condense(rounds: readonly Round[]): CondensedShare[] {
  const byEnd = new Map<string, CondensedShare>();
  for (const round of rounds) {
    for (const hit of round.hits) {
      let share = byEnd.get(hit.toKey);
      if (share === undefined) {
        share = { to: hit.to, toKey: hit.toKey, dealt: 0, prevented: 0, combat: false, firstEventIndex: hit.eventIndex };
        byEnd.set(hit.toKey, share);
      }
      if (hit.outcome === 'dealt') share.dealt += hit.amount;
      else share.prevented += hit.amount;
      share.combat ||= hit.combat;
    }
  }
  return [...byEnd.values()];
}

/** Did any of these rounds see this end die? */
function diedIn(rounds: readonly Round[], toKey: string): boolean {
  for (const round of rounds) if (round.died.has(toKey)) return true;
  return false;
}

/**
 * Fold a batch of freshly-appended events into the damage beats they earn.
 *
 * The plan is built round by round against a time budget; see the module doc for
 * the round rule and for what happens when the budget binds.
 */
export function deriveDamageSequence(
  events: readonly GameEvent[],
  opts: DeriveDamageOptions,
): readonly DamageBeat[] {
  if (opts.reducedMotion) return NO_BEATS;
  const rounds = roundsIn(events, opts.startIndex);
  if (rounds.length === 0) return NO_BEATS;
  const { travelMs, impactMs, staggerMs, maxPerBatch, maxTotalMs } = DAMAGE_ANIM_CONFIG;
  const out: DamageBeat[] = [];
  const condensedMs = condensedRoundMs();

  const pushCondensed = (group: readonly Round[], roundIndex: number, startMs: number): void => {
    for (const share of condense(group)) {
      const dealt = share.dealt > 0;
      out.push({
        key: `${share.firstEventIndex}:c${share.toKey}`,
        kind: 'condensed',
        roundIndex,
        from: null,
        to: share.to,
        amount: dealt ? share.dealt : share.prevented,
        outcome: dealt ? 'dealt' : 'prevented',
        combat: share.combat,
        // Prevented damage cannot be lethal, even if the recipient died to
        // something else in the same round — the beat says "this fizzled".
        lethal: dealt && diedIn(group, share.toKey),
        startMs,
        travelMs: 0,
        impactMs,
      });
    }
  };

  let cursor = 0;
  let r = 0;
  while (r < rounds.length) {
    const round = rounds[r] as Round;
    const full = fullRoundMs(round.hits.length);
    if (round.hits.length <= maxPerBatch && cursor + full <= maxTotalMs) {
      round.hits.forEach((hit, i) => {
        out.push({
          key: `${hit.eventIndex}`,
          kind: 'hit',
          roundIndex: r,
          from: hit.from,
          to: hit.to,
          amount: hit.amount,
          outcome: hit.outcome,
          combat: hit.combat,
          lethal: hit.outcome === 'dealt' && round.died.has(hit.toKey),
          startMs: cursor + i * staggerMs,
          travelMs,
          impactMs,
        });
      });
      cursor += full;
      r += 1;
      continue;
    }
    if (cursor + condensedMs <= maxTotalMs) {
      // This round alone is too big (or too late) to animate hit by hit, but the
      // budget still has room for a round: condense THIS one and carry on, so a
      // later, smaller round can still be shown in full.
      pushCondensed([round], r, cursor);
      cursor += condensedMs;
      r += 1;
      continue;
    }
    // The budget is spent. Everything still unplayed collapses into ONE final
    // condensed round — never silence, and never an unbounded tail: this is the
    // single overrun the cap allows, and it is exactly `condensedRoundMs()` long.
    pushCondensed(rounds.slice(r), r, cursor);
    break;
  }
  return out.length > 0 ? out : NO_BEATS;
}

/**
 * How long the whole sequence runs, ms — the last impact plus the settle beat.
 *
 * Provably `<= DAMAGE_ANIM_CONFIG.maxTotalMs + impactMs + settleHoldMs` for ANY
 * input, which is the claim `damage-sequence.test.ts` pins. A cap the timings can
 * exceed without bound is not a cap.
 */
export function sequenceDurationMs(beats: readonly DamageBeat[]): number {
  let end = 0;
  for (const beat of beats) end = Math.max(end, beat.startMs + beat.travelMs + beat.impactMs);
  return end === 0 ? 0 : end + DAMAGE_ANIM_CONFIG.settleHoldMs;
}

/**
 * How long a permanent's DEATH should wait before it plays, so the hit that
 * killed it lands first — "a lethal hit and the creature vanishing are two
 * events rather than one", which is the reason `settleHoldMs` exists.
 *
 * Returns 0 when nothing in this batch hit that instance, so a Doom Blade's
 * victim still vanishes immediately. Consumed by `deriveAnimations`'s
 * `deathHoldMsFor`, which is what keeps the two layers on one clock instead of
 * each guessing at the other's.
 */
export function damageHoldMsFor(beats: readonly DamageBeat[], instanceId: InstanceId): number {
  let end = 0;
  for (const beat of beats) {
    if (beat.to.where !== 'tile' || beat.to.instanceId !== instanceId) continue;
    end = Math.max(end, beat.startMs + beat.travelMs + beat.impactMs);
  }
  return end;
}

/**
 * THE BENCH TABLE (CLAUDE.md rule 3) — one row per presentation this system can
 * produce, each a real batch of engine events run through the real fold, so what
 * the effects bench auditions is exactly what a game draws. Adding a
 * presentation is a ROW here, never an edit to the bench component.
 *
 * The instance ids and the seat are the ones `DamageBench` puts on its stage; a
 * row naming anything else would simply measure nothing, which is the same
 * graceful skip the live layer performs when a tile has left the board.
 */
export interface DamageBenchRow {
  readonly id: string;
  readonly label: string;
  readonly events: readonly GameEvent[];
}

/** The stage's two mock tiles and the seat its face damage lands on. */
export const DAMAGE_BENCH_SOURCE_ID: InstanceId = 1;
export const DAMAGE_BENCH_TARGET_ID: InstanceId = 2;
export const DAMAGE_BENCH_THIRD_ID: InstanceId = 3;
export const DAMAGE_BENCH_SEAT: PlayerId = 'B';

const A = DAMAGE_BENCH_SOURCE_ID;
const B = DAMAGE_BENCH_TARGET_ID;
const C = DAMAGE_BENCH_THIRD_ID;

/** A `damageDealt` event, spelled once so the rows below stay readable. */
function dealt(source: InstanceId, target: InstanceId | PlayerId, amount: number, combat = true): GameEvent {
  return { type: 'damageDealt', source, target, amount, combat };
}

/** A `damagePrevented` event (see {@link dealt}). */
function prevented(source: InstanceId, target: InstanceId | PlayerId, amount: number): GameEvent {
  return { type: 'damagePrevented', source, target, amount, combat: true };
}

/** A `creatureDied` event (see {@link dealt}). */
function died(instanceId: InstanceId, name: string): GameEvent {
  return { type: 'creatureDied', instanceId, name };
}

export const DAMAGE_BENCH_ROWS: readonly DamageBenchRow[] = Object.freeze([
  Object.freeze({
    id: 'survivable',
    label: 'Creature hits creature (survives)',
    events: Object.freeze([dealt(A, B, 2)]),
  }),
  Object.freeze({
    id: 'lethal',
    label: 'Lethal hit (creature dies)',
    events: Object.freeze([dealt(A, B, 5), died(B, 'Bench Bear')]),
  }),
  Object.freeze({
    id: 'face',
    label: 'Damage to a player’s face',
    events: Object.freeze([dealt(A, DAMAGE_BENCH_SEAT, 4)]),
  }),
  Object.freeze({
    id: 'prevented',
    label: 'Prevented damage (fizzles)',
    events: Object.freeze([prevented(A, B, 3)]),
  }),
  Object.freeze({
    id: 'trade',
    label: 'Trade: attacker and blocker hit each other',
    events: Object.freeze([dealt(A, B, 3), dealt(B, A, 3), died(A, 'Bench Attacker'), died(B, 'Bench Blocker')]),
  }),
  Object.freeze({
    id: 'firstStrike',
    label: 'First strike: two rounds',
    events: Object.freeze([dealt(A, B, 2), dealt(A, B, 2), dealt(B, A, 3)]),
  }),
  Object.freeze({
    id: 'condensed',
    label: 'Board-wide combat (condenses)',
    events: Object.freeze(
      Array.from({ length: DAMAGE_ANIM_CONFIG.maxPerBatch + 2 }, (_, i) =>
        dealt(100 + i, i % 3 === 0 ? B : i % 3 === 1 ? C : DAMAGE_BENCH_SEAT, 1 + (i % 4)),
      ),
    ),
  }),
]);
