/**
 * FULL-POOL SOAK — the named constants, the mechanic inventory, and the
 * event-classification manifest (`soak.ts` is the runner; `soak-decks.ts` builds
 * the decks).
 *
 * ## Why this file exists
 * Twelve engine systems shipped in three days — planeswalkers, battles, the
 * legend rule, emblems, transform, modal casting, flashback + graveyard grants,
 * protection/ward, indestructible, {X}/kicker, cycling/buyback/madness,
 * scry/surveil, counters, characteristic-defining P/T, turn facts and the
 * mana-ability model — and the pool went 191 → 357 cards. Every one of them was
 * tested IN ISOLATION by the agent that built it. Almost none were tested
 * TOGETHER. The gauntlet decks in `../data/decks` are curated and small; they
 * exercise a fraction of the pool and essentially none of the collisions.
 *
 * The soak plays thousands of seeded games with randomised-but-legal decks drawn
 * from the WHOLE pool, deliberately mixing systems, and asserts INVARIANTS. It
 * exists because this repo's recorded failure shape is "a check that reports
 * something other than *I didn't check*" — a suite that asserts games finish
 * while a combat bug makes them unable to end.
 *
 * ## The two things a soak has to get right
 * 1. **Every failure must reproduce.** Everything here is a pure function of a
 *    seed; a violation prints the seed AND both decklists, so `soak.test.ts`'s
 *    failure message is a bug report you can paste into a new test.
 * 2. **Every mechanic must actually OCCUR.** A soak that never casts a flashback
 *    spell proves nothing about flashback. {@link SOAK_MECHANICS} is the
 *    inventory, and the run FAILS when a mechanic the POOL prints never fires —
 *    the sim-side twin of `packages/cards/src/pool-mechanics.test.ts`, which
 *    fails when a mechanic loses its last card. Between them, "shipped but
 *    unreachable" has nowhere to hide.
 *
 * ## Wall clock is not a signal on this box
 * Ten agents run concurrently here and the same build has measured 39–87
 * games/sec within one hour. NOTHING in the soak is gated on elapsed time: the
 * tiers are sized in GAMES, the cost signal is `process.cpuUsage`, and the caps
 * that bound a game are turn/action counts (`SimConfig`), never a deadline.
 */

import type { CardDefinition, GameEvent } from '@jonny-boi/core';

// ---------------------------------------------------------------------------
// Tier sizes. Sized in GAMES — never in seconds (see the header).
// ---------------------------------------------------------------------------

/**
 * Games the FAST tier plays inside the ordinary suite.
 *
 * It is deliberately load-bearing rather than decorative: it plays one
 * mechanic-anchored matchup per entry in {@link SOAK_MECHANICS} plus a block of
 * unanchored mixed decks, and it runs every invariant on every decision. The
 * number is a floor, not the count — `soak.test.ts` derives the real total from
 * the inventory so adding a mechanic widens the fast tier automatically.
 */
export const SOAK_FAST_MIXED_GAMES = 40;

/** Games the DEEP tier plays when `JB_SOAK_GAMES` (or the CLI) asks for it. */
export const SOAK_DEEP_DEFAULT_GAMES = 2000;

/** The env var that turns the deep tier on inside Vitest, and sets its size. */
export const SOAK_DEEP_ENV_VAR = 'JB_SOAK_GAMES';

/**
 * Seed the whole soak derives from. Every deck, every game and every shuffle is
 * a pure function of it, so one number reproduces an entire run.
 */
export const SOAK_BASE_SEED = 0x50a4;

/**
 * How many seeded attempts the fast tier gives one mechanic before it calls the
 * mechanic inert.
 *
 * A single seed is too brittle: a pool edit by a sibling reshuffles which card
 * the pilot draws, and a mechanic that fires on seed 3 rather than seed 1 is not
 * a defect. A short deterministic LIST keeps the tier reproducible while
 * surviving ordinary churn — and a mechanic that fires on none of them is a real
 * finding, because its anchored deck is nothing but that mechanic's cards.
 */
export const SOAK_MECHANIC_SEED_ATTEMPTS = 6;

/**
 * Deep-tier games between full in-place-vs-cloning equivalence replays.
 *
 * The replay costs a second full game, so it samples rather than doubling the
 * run. The fast tier replays a fixed set instead (see `soak.test.ts`).
 */
export const SOAK_EQUIVALENCE_SAMPLE_EVERY = 97;

/**
 * Deep-tier games between observation-leak scans (the redaction scan). Scanning
 * attaches an observing pilot, which changes `runMatch`'s observer path, so it
 * samples rather than running always.
 */
export const SOAK_LEAK_SCAN_SAMPLE_EVERY = 31;

// ---------------------------------------------------------------------------
// Bounds a soaked game must respect. These are the "the game can still END"
// guards — the class of bug that once shipped while every test passed.
// ---------------------------------------------------------------------------

/**
 * Hard action cap for a soaked game. Below `DEFAULT_SIM_CONFIG.maxActionsPerGame`
 * on purpose: the soak treats hitting the cap as a DEFECT, so it wants to notice
 * a runaway game quickly rather than burn 20,000 actions first. A real 60-turn
 * game of these decks lands well under this.
 */
export const SOAK_MAX_ACTIONS_PER_GAME = 6000;

/** Hard turn cap. Matches the shipped default so timeouts mean the same thing. */
export const SOAK_MAX_TURNS_PER_GAME = 60;

/**
 * Stack depth beyond which the soak calls a game pathological.
 *
 * A legitimate board can stack a handful of triggers; a hundred means a trigger
 * loop, which is a state the game cannot leave. Named rather than inline so the
 * number is arguable instead of magic.
 */
export const SOAK_MAX_STACK_DEPTH = 100;

/**
 * The fraction of soaked games allowed to end in a turn-cap timeout draw.
 *
 * Random decks stall more than curated ones — a pile of defenders really can go
 * to turn 60 — so zero is the wrong bar. What is NOT allowed is the ACTION cap
 * (see {@link SOAK_MAX_ACTIONS_PER_GAME}), which no legitimate game reaches and
 * which is the signature of "the game cannot end".
 */
export const SOAK_MAX_TIMEOUT_RATE = 0.35;

// ---------------------------------------------------------------------------
// The mechanic inventory.
// ---------------------------------------------------------------------------

/**
 * Every mechanic the soak knows how to WATCH FOR. Closed union so a probe table
 * with a typo does not compile, and so the event manifest below can name them.
 */
export type SoakMechanicId =
  | 'planeswalker-loyalty'
  | 'planeswalker-attacked'
  | 'battle-defense'
  | 'legend-rule'
  | 'emblem'
  | 'transform-dfc'
  | 'modal-cast'
  | 'flashback-cast'
  | 'graveyard-grant'
  | 'protection'
  | 'ward'
  | 'indestructible'
  | 'blocking-restriction'
  | 'x-cost'
  | 'kicker'
  | 'cycling'
  | 'buyback'
  | 'madness'
  | 'scry'
  | 'surveil'
  | 'mill'
  | 'counters'
  | 'characteristic-pt'
  | 'static-buff'
  | 'turn-facts'
  | 'mana-ability-extras'
  | 'attachment'
  | 'token'
  | 'triggered-ability'
  | 'trigger-targets'
  | 'control-change'
  | 'damage-prevention'
  | 'graveyard-recursion'
  | 'optional-payment'
  | 'lifegain'
  // The four systems merged into main on 2026-08-20. Each is watched from the
  // day it lands, so nobody has to remember to come back and add it.
  | 'second-castable-face'
  | 'as-enters-choice'
  | 'additional-cast-cost'
  | 'intervening-if'
  | 'tutor-route'
  // Landed 2026-08-20 alongside the four above, and watched from the same day for
  // the same reason. `replacement` is the CR 614/615 layer; `uncounterable` is the
  // "this spell can't be countered" rule, whose whole observable behaviour is a
  // counter effect resolving and doing nothing.
  | 'replacement'
  | 'uncounterable';

/**
 * How a mechanic is proved to have HAPPENED.
 *
 * Three kinds, and the distinction is not cosmetic — it is how honest the claim
 * is, so the report prints it:
 *
 *  - `'action'` — a player really submitted the action the mechanic is made of
 *    (a flashback cast names its graveyard zone; a cycle is its own action kind).
 *    The strongest witness there is: the mechanic was USED.
 *  - `'event'` — the engine logged the mechanic resolving. Equally strong; it is
 *    just that some mechanics have no action of their own (the legend rule fires
 *    itself).
 *  - `'state'` — the mechanic's card was live in the zone its rules text
 *    operates in (a protection creature actually on the battlefield). WEAKER,
 *    and labelled as such wherever it is reported: it proves the static was in
 *    force, not that anything ran into it. Used only where the engine emits no
 *    event and the player takes no action — protection is refused targeting by a
 *    silent legality answer, not by a log line.
 */
export type SoakWitnessKind = 'action' | 'event' | 'state';

/** One mechanic: is it in the pool at all, and how would we know it fired? */
export interface SoakMechanic {
  readonly id: SoakMechanicId;
  /** Human wording used in failure messages. */
  readonly label: string;
  readonly witnessKind: SoakWitnessKind;
  /**
   * Does THIS card print the mechanic? Drives the requirement: the soak demands
   * an occurrence only for mechanics the pool can actually produce, so a
   * mechanic with no card is reported by `pool-mechanics.test.ts` (whose job it
   * is) rather than failing here for a reason the soak cannot fix.
   */
  readonly printedBy: (card: CardDefinition, serialized: string) => boolean;
  /**
   * Cards that ENABLE the mechanic — the ones a deck also needs before the
   * anchor card can do anything.
   *
   * Most mechanics enable themselves: a flashback spell reaches the graveyard by
   * being cast, a protection creature is attacked in the ordinary course of
   * combat. Madness does not — a madness card sits in hand for ever unless
   * something DISCARDS it, and this engine has no cleanup-step hand-size discard
   * (CR 514.1) to do it unprompted, so the only outlets are the three cards in
   * the pool that make a player discard. An anchored deck packs its enablers
   * alongside its anchors; without that the soak would report madness inert and
   * be reporting the deck, not the engine.
   */
  readonly enabledBy?: (card: CardDefinition, serialized: string) => boolean;
}

/** Serialize a definition once for the cheap "does it mention" probes. */
export function serializeDefinition(card: CardDefinition): string {
  return JSON.stringify(card);
}

const hasKey = (key: string) => (card: CardDefinition) =>
  (card as unknown as Record<string, unknown>)[key] !== undefined;

/**
 * THE INVENTORY. Predicates, never card-name lists: a generator that swaps one
 * card for a better one must not break this file, and a name list would rot
 * silently until somebody noticed.
 */
export const SOAK_MECHANICS: readonly SoakMechanic[] = [
  {
    id: 'planeswalker-loyalty',
    label: 'planeswalkers — a loyalty ability activated',
    witnessKind: 'action',
    printedBy: (c) => c.types.includes('planeswalker'),
  },
  {
    id: 'planeswalker-attacked',
    label: 'planeswalkers — attacked by a creature',
    witnessKind: 'action',
    printedBy: (c) => c.types.includes('planeswalker'),
  },
  {
    id: 'battle-defense',
    label: 'battles — defense counters removed',
    witnessKind: 'event',
    printedBy: (c) => c.types.includes('battle'),
  },
  {
    id: 'legend-rule',
    label: 'the legend rule — a duplicate legend put into a graveyard',
    witnessKind: 'event',
    printedBy: (c) => (c as { legendary?: boolean }).legendary === true,
  },
  {
    id: 'emblem',
    label: 'emblems — an emblem created in the command zone',
    witnessKind: 'event',
    printedBy: (_c, t) => t.includes('"emblem"'),
  },
  {
    id: 'transform-dfc',
    label: 'transforming double-faced cards — a permanent flipped',
    witnessKind: 'event',
    printedBy: hasKey('backFace'),
  },
  {
    id: 'modal-cast',
    label: 'modal spells — modes announced at cast',
    witnessKind: 'event',
    printedBy: hasKey('modal'),
  },
  {
    id: 'flashback-cast',
    label: 'flashback — a spell cast from the graveyard',
    witnessKind: 'action',
    printedBy: (c, t) =>
      (c as { flashback?: unknown }).flashback !== undefined
      || (c as { flashbackXCost?: unknown }).flashbackXCost !== undefined
      || t.includes('grantFlashback'),
  },
  {
    id: 'graveyard-grant',
    label: 'graveyard grants — an ability granted to a card in a graveyard',
    witnessKind: 'event',
    printedBy: (_c, t) => t.includes('grantFlashback'),
  },
  {
    id: 'protection',
    label: 'protection — a permanent with protection live on the battlefield',
    witnessKind: 'state',
    printedBy: (_c, t) => t.includes('protectionFrom'),
  },
  {
    id: 'ward',
    label: 'ward — a permanent with ward live on the battlefield',
    witnessKind: 'state',
    printedBy: (_c, t) => /"ward":\s*\d/.test(t),
  },
  {
    id: 'indestructible',
    label: 'indestructible — an indestructible permanent live on the battlefield',
    witnessKind: 'state',
    printedBy: (_c, t) => t.includes('indestructible'),
  },
  {
    id: 'blocking-restriction',
    label: 'blocking restrictions — menace / defender / can’t-block live in combat',
    witnessKind: 'state',
    printedBy: (_c, t) => /"(menace|defender|cantBlock)":\s*true|"minBlockers":\s*\d/.test(t),
  },
  {
    id: 'replacement',
    label: 'replacement / prevention — an event changed before it happened',
    witnessKind: 'event',
    printedBy: hasKey('replacements'),
  },
  {
    id: 'uncounterable',
    label: "can't be countered — a counter effect resolved and did nothing",
    witnessKind: 'event',
    printedBy: (_c, t) => /"cantBeCountered":\s*true|"spellsCantBeCountered":/.test(t),
  },
  { id: 'x-cost', label: '{X} costs — an X announced and paid', witnessKind: 'event', printedBy: hasKey('xCost') },
  { id: 'kicker', label: 'kicker — the optional cost offered at cast', witnessKind: 'event', printedBy: hasKey('kicker') },
  { id: 'cycling', label: 'cycling — a card cycled from hand', witnessKind: 'action', printedBy: hasKey('cycling') },
  {
    id: 'buyback',
    label: 'buyback — the optional cost offered at cast',
    witnessKind: 'event',
    printedBy: hasKey('buyback'),
  },
  {
    id: 'madness',
    label: 'madness — a discarded card exiled with its window open',
    witnessKind: 'event',
    printedBy: hasKey('madness'),
    // The discard outlets. `discardCard` is the choice primitive every "discard
    // a card" clause in the pool resolves through, which is exactly the funnel
    // madness hooks — so this finds the enablers by BEHAVIOUR rather than by a
    // list of three card names that would rot the moment the pool grew.
    enabledBy: (_c, t) => t.includes('discardCard'),
  },
  { id: 'scry', label: 'scry — the top of a library looked at and reordered', witnessKind: 'event', printedBy: (_c, t) => t.includes('"scry"') },
  { id: 'surveil', label: 'surveil — the top of a library looked at, graveyard available', witnessKind: 'event', printedBy: (_c, t) => t.includes('"surveil"') },
  { id: 'mill', label: 'mill — cards moved library → graveyard', witnessKind: 'event', printedBy: (_c, t) => t.includes('"mill"') },
  { id: 'counters', label: '+1/+1 (and friends) counters added', witnessKind: 'event', printedBy: (_c, t) => t.includes('addCounters') },
  {
    id: 'characteristic-pt',
    label: 'characteristic-defining P/T — a ★/★ creature live on the battlefield',
    witnessKind: 'state',
    printedBy: hasKey('characteristicPT'),
  },
  {
    id: 'static-buff',
    label: 'continuous statics — a permanent printing one live on the battlefield',
    witnessKind: 'state',
    printedBy: (c) => ((c as { statics?: readonly unknown[] }).statics ?? []).length > 0,
  },
  {
    id: 'turn-facts',
    label: 'turn facts — revolt / morbid / lifegain recorded for a turn',
    witnessKind: 'state',
    // Turn facts are recorded by the ENGINE for every game, not printed on a
    // card; the cards that READ them are the ones that make the record matter.
    // Every pool card can set one (any permanent leaving play sets revolt), so
    // this is unconditionally required — which is the honest bar for a fact the
    // engine records unprompted.
    printedBy: () => true,
  },
  {
    id: 'mana-ability-extras',
    label: 'the mana-ability model — a source with a cost / rider / restriction tapped',
    witnessKind: 'action',
    printedBy: (c) => ((c as { manaAbilities?: readonly unknown[] }).manaAbilities ?? []).length > 0,
  },
  { id: 'attachment', label: 'attachments — an Aura or Equipment attached', witnessKind: 'event', printedBy: (c) => (c as { attachment?: unknown }).attachment !== undefined },
  { id: 'token', label: 'tokens — a token created', witnessKind: 'event', printedBy: (_c, t) => t.includes('createToken') || t.includes('makeToken') },
  { id: 'triggered-ability', label: 'triggered abilities — one put on the stack', witnessKind: 'event', printedBy: (c) => ((c as { triggers?: readonly unknown[] }).triggers ?? []).length > 0 },
  {
    id: 'trigger-targets',
    label: 'trigger targets — a trigger aimed as it went on the stack',
    witnessKind: 'event',
    printedBy: (_c, t) => t.includes('"targets"') && t.includes('"triggers"'),
  },
  { id: 'control-change', label: 'control change — a permanent changed controller', witnessKind: 'event', printedBy: (_c, t) => t.includes('gainControl') },
  { id: 'damage-prevention', label: 'damage prevention — damage prevented rather than dealt', witnessKind: 'event', printedBy: (_c, t) => t.includes('preventDamage') || t.includes('"protectionFrom"') },
  { id: 'graveyard-recursion', label: 'graveyard recursion — a card returned from a graveyard', witnessKind: 'event', printedBy: (_c, t) => t.includes('returnFromGraveyard') || t.includes('persistReturn') },
  {
    id: 'optional-payment',
    label: 'optional payment — a "you may pay" question asked',
    witnessKind: 'event',
    printedBy: (_c, t) => t.includes('counterUnlessPaid') || t.includes('unlessPaid') || t.includes('mayEffects'),
  },
  { id: 'lifegain', label: 'life gain — a player gained life', witnessKind: 'event', printedBy: (_c, t) => t.includes('gainLife') },

  /*
   * --- the 2026-08-20 arrivals -------------------------------------------------
   *
   * Four systems landed on `main` together (§3.21 ×3 and the tutor/additional-cost
   * templates) and the SHIPPED POOL prints none of them: the compiler got wider,
   * the pool was never regenerated. They are in the inventory anyway, and that is
   * the point of a self-maintaining inventory — today the soak reports each as
   * "not in the pool (not required)", out loud rather than by silence, and the
   * moment one card appears it becomes a mechanic the run FAILS without.
   */
  {
    id: 'second-castable-face',
    label: 'a second castable face — split / adventure / aftermath / modal DFC',
    witnessKind: 'action',
    // One flag covers the whole family: `backFaceCastable` is what makes a
    // `castSpell` with `face: 'back'` legal, whichever layout produced it.
    printedBy: (c) => (c as { backFaceCastable?: boolean }).backFaceCastable === true,
  },
  {
    id: 'as-enters-choice',
    label: '"as ~ enters, choose a…" — a value named on entry and remembered',
    witnessKind: 'event',
    printedBy: (c) => (c as { asEntersChoice?: unknown }).asEntersChoice !== undefined,
  },
  {
    id: 'additional-cast-cost',
    label: 'a mandatory additional cost paid as the spell is cast',
    witnessKind: 'event',
    printedBy: (c) => (c as { additionalCost?: unknown }).additionalCost !== undefined,
  },
  {
    id: 'intervening-if',
    label: 'an intervening "if" clause on a triggered ability (CR 603.4)',
    witnessKind: 'state',
    // Witnessed BOTH ways, and the stronger one is the event: `triggerFizzled`
    // is CR 603.4's second check actually firing. The state witness ("a card
    // printing one is on the battlefield") is the fallback for the far commoner
    // case where the condition simply stays true.
    // The clause lives on the trigger's CONDITION, so it serializes under
    // `intervening` — checked as text because a card may print several triggers
    // and only one of them may carry it.
    printedBy: (_c, t) => t.includes('"intervening"'),
  },
  {
    id: 'tutor-route',
    label: 'a multi-destination library search (one card here, one there)',
    witnessKind: 'event',
    printedBy: (_c, t) => t.includes('"route"'),
  },
];

// ---------------------------------------------------------------------------
// The event-classification manifest — a NEW ENGINE EVENT BREAKS THE BUILD.
// ---------------------------------------------------------------------------

/**
 * What seeing one event type proves.
 *
 * A {@link SoakMechanicId} means "this event alone is proof that mechanic
 * fired". `null` means "this event proves no particular mechanic" — either it is
 * pure bookkeeping (a step began), or the mechanic it belongs to is witnessed
 * more precisely elsewhere (a flashback cast is recognised from the ACTION,
 * which names the zone, not from the `spellCast` event that every cast emits).
 *
 * Declared as a **mapped type over `GameEvent['type']`**, exactly like
 * `observation.ts`'s `OBSERVATION_POLICY` and `paired-arms-config.ts`'s
 * primitive classification, and for exactly the same reason: **the next engine
 * system to ship adds an event type, and this file must stop compiling until
 * somebody says whether it is a mechanic the soak should now require.** That is
 * the only mechanism in the repo that notices a *new* system going untested,
 * rather than an existing one going uncarded.
 */
export const SOAK_EVENT_WITNESS: { readonly [K in GameEvent['type']]: SoakMechanicId | null } = {
  // --- Bookkeeping: real events, no particular mechanic. ---------------------
  gameStart: null,
  turnBegin: null,
  stepBegin: null,
  priorityPassed: null,
  untapped: null,
  tapped: null,
  drawCard: null,
  zoneChange: null,
  landPlayed: null,
  manaAdded: null,
  manaPoolEmptied: null,
  manaCostPaid: null,
  stackResolved: null,
  effectApplied: null,
  /*
   * NOT a mechanic — the opposite. `effectUnsupported` is the engine saying a
   * card referenced a primitive no registry provides, which it then no-ops
   * (DESIGN §1.6 robustness: a safe default and a clear signal, never a crash).
   * Every card in the shipped pool compiles `'complete'`, so in a soak it must
   * NEVER fire: one means a pool card is quietly playing as less than it prints,
   * and a quietly weakened card biases every A/B verdict built on it. The soak
   * asserts that as an invariant (`SOAK_INVARIANTS.noUnsupportedEffect`) rather
   * than tallying it as an occurrence.
   */
  effectUnsupported: null,
  lifeChanged: null,
  creatureDied: null,
  playerLost: null,
  gameOver: null,
  damageDealt: null,
  attackersDeclared: null,
  blockersDeclared: null,
  continuousEffectAdded: null,
  continuousEffectExpired: null,
  triggeredAbilityResolved: null,
  triggerRemovedFromStack: null,
  choiceAnswered: null,
  choiceAutoAnswered: null,
  choiceAbandoned: null,
  attachmentFailed: null,
  attachmentPutIntoGraveyard: null,
  permanentUnattached: null,
  /*
   * `actionRejected` is bookkeeping for the tally and a DEFECT for the
   * invariants: the soak verifies every action it submits came out of
   * `generateLegalActions`, so a rejection means the menu and the apply path
   * disagree. See `soak.ts`'s `noRejectedActions` invariant.
   */
  actionRejected: null,
  /*
   * A cast is not self-describing: an ordinary cast, a flashback cast and a
   * madness cast all emit `spellCast`. The soak reads the ACTION instead, which
   * names `fromZone` and `face`, so this stays `null` rather than being
   * mis-credited to whichever mechanic it happens to be.
   */
  spellCast: null,
  /*
   * Likewise: `abilityActivated` covers every activated ability, so it cannot
   * distinguish a loyalty ability from an Equipment's equip. The action carries
   * the source, and the soak resolves it against the definition.
   */
  abilityActivated: null,
  /*
   * `cardsLookedAt` is emitted identically by scry and surveil (a count and a
   * player — that is all a spectator sees, deliberately). Which one it was lives
   * in the SOURCE card, so the soak credits it from the `choiceAsked` that
   * preceded it. See `soak.ts`.
   */
  cardsLookedAt: null,
  /*
   * Every parked question emits this, so it names no single mechanic — but it
   * carries `sourceInstanceId`, which is what lets the soak credit X, kicker,
   * buyback, scry and surveil to the card that actually asked.
   */
  choiceAsked: null,
  /*
   * `counterAdded` covers +1/+1, loyalty AND defense counters. Loyalty and
   * defense have their own events (`loyaltyChanged`, `defenseChanged`), so
   * crediting this one to `counters` unconditionally would let a planeswalker
   * entering play satisfy the +1/+1-counter requirement. The soak filters on the
   * counter KIND instead.
   */
  counterAdded: null,

  // --- One event, one mechanic. ---------------------------------------------
  loyaltyChanged: 'planeswalker-loyalty',
  planeswalkerDied: 'planeswalker-loyalty',
  defenseChanged: 'battle-defense',
  battleDefeated: 'battle-defense',
  legendRuleApplied: 'legend-rule',
  emblemCreated: 'emblem',
  transformed: 'transform-dfc',
  modesChosen: 'modal-cast',
  modeTargetChosen: 'modal-cast',
  /*
   * ARRIVED WITH THE 2026-08-20 MERGE, and the mapped type is what made anybody
   * look: both were new `GameEvent` members, so this file stopped compiling
   * until they were classified. That is the whole reason it is a mapped type.
   */
  // A permanent ANNOUNCED the value it named as it entered — public, and a
  // stronger witness than finding `chosenAsEntered` on a board later, because it
  // pins the moment.
  chosenAsEnters: 'as-enters-choice',
  /*
   * A trigger left the stack because its intervening "if" had stopped being true
   * (CR 603.4's SECOND check). That is the half of the rule an `if` inside the
   * effects could never implement, so it is the only unambiguous proof the
   * system is doing what it claims.
   */
  triggerFizzled: 'intervening-if',
  cardGrantAdded: 'graveyard-grant',
  cardGrantExpired: 'graveyard-grant',
  cardCycled: 'cycling',
  madnessWindowOpened: 'madness',
  madnessDeclined: 'madness',
  cardsMilled: 'mill',
  tokenCreated: 'token',
  triggerPutOnStack: 'triggered-ability',
  triggerTargetsChosen: 'trigger-targets',
  controlChanged: 'control-change',
  damagePrevented: 'damage-prevention',
  // The CR 614/615 layer, and the rule that makes a counterspell resolve into
  // nothing. Both are logged precisely so a replay can show WHY the number
  // changed (or did not) — see the events' own comments — which is what makes
  // them event witnesses rather than state ones.
  replacementApplied: 'replacement',
  replacementExpired: 'replacement',
  counterPrevented: 'uncounterable',
  permanentAttached: 'attachment',
  gainLife: 'lifegain',
};

// ---------------------------------------------------------------------------
// Invariant names. Constants so a failure message, the report and the docs
// cannot drift apart, and so a test can name the one it means.
// ---------------------------------------------------------------------------

export const SOAK_INVARIANTS = {
  noException: 'the engine never throws',
  legalActionsOnly: 'every action a pilot submits came from generateLegalActions',
  noRejectedActions: 'the engine never rejects an action it offered',
  noUnsupportedEffect: 'no pool card resolves an effect the registry cannot provide',
  gameCanEnd: 'a game never reaches the action cap',
  stackEmpties: 'the stack empties before the turn ends',
  stackDepth: 'the stack never runs away',
  uniqueZones: 'an instance is in exactly one zone',
  zoneFieldAgrees: 'instance.zone matches the zone it is actually in',
  deadCreaturesLeave: 'state-based actions remove 0-toughness / lethally damaged creatures',
  deadWalkersLeave: 'state-based actions remove 0-loyalty planeswalkers',
  deadBattlesLeave: 'state-based actions remove 0-defense battles',
  lossAtZeroLife: 'a player at 0 life has lost',
  countersNonNegative: 'loyalty / defense / +1+1 counters never go negative',
  manaPoolNonNegative: 'a mana pool never goes negative',
  choiceChannel: 'while a question is outstanding only its chooser may answer it',
  landDropCap: 'land drops are capped',
  cardsNeverVanish: 'an original card is always in some zone',
  untapAtTurnStart: 'your permanents untap as your turn begins',
  damageClears: 'marked damage clears in the cleanup step',
  temporaryEffectsExpire: '"until end of turn" effects expire',
  noObservationLeak: 'no card in a hidden zone leaks into an observation',
  inPlaceEquivalence: 'applyActionInPlace is bit-identical to applyAction',
  mechanicOccurred: 'every mechanic the pool prints actually fires',
} as const;

export type SoakInvariantName = (typeof SOAK_INVARIANTS)[keyof typeof SOAK_INVARIANTS];
