/**
 * The MODEL GAME ("MicroMTG") — the fixed, representative workload every arm
 * implements 100% of.
 *
 * WHY A MODEL GAME AND NOT THE REAL ENGINE
 * ----------------------------------------
 * The question this spike answers is "how much of the engine hot-path cost is the
 * DATA REPRESENTATION and how much is the LANGUAGE?". Answering it needs at least
 * two implementations of the SAME rules with different representations. Porting
 * `packages/core` (≈4,500 non-test lines, an Oracle-text card compiler, a choice
 * system, a layered continuous-effects engine) twice is not a spike.
 *
 * So all arms implement this cut-down but STRUCTURALLY FAITHFUL game instead. It
 * keeps every ingredient that makes the real hot path expensive — ordered zones,
 * a stack, priority passes, per-step turn structure, mana payment, targeting,
 * combat, state-based actions, and a separate until-end-of-turn continuous-effect
 * list that effective P/T must be layered over — and drops the things that are
 * rules SURFACE rather than hot-path SHAPE (triggered/activated abilities, the
 * choice system, attachments, modal spells, {X} costs, replacement effects).
 *
 * `calibrate.mjs` measures the real engine and this model side by side so the
 * reader can judge how far the extrapolation stretches. See README §"What the
 * prototypes did NOT implement".
 *
 * THE ENCODING IS SHARED ON PURPOSE. Arms B (flat TypedArray JS) and C
 * (AssemblyScript→WASM) read the SAME integer card table, so a divergence between
 * them can only come from the runtime, never from the data.
 */

// --- game constants (rule 3: no magic numbers) ------------------------------------

export const STARTING_LIFE = 20;
export const OPENING_HAND = 7;
export const DECK_SIZE = 60;
export const MAX_LANDS_PER_TURN = 1;
export const NUM_PLAYERS = 2;
/** 2 decks of 60. No tokens in the model, so instance ids are fixed for a whole game. */
export const MAX_INSTANCES = DECK_SIZE * NUM_PLAYERS;
/** Hard cap so a pathological game cannot run forever; matches the real engine's habit. */
export const ACTION_CAP = 4000;
export const MAX_TURNS = 60;

/** Zone capacities for the flat arms. Sized to the worst case the model can reach. */
export const CAP_LIBRARY = DECK_SIZE;
export const CAP_HAND = 40;
export const CAP_BATTLEFIELD = 60;
export const CAP_GRAVEYARD = DECK_SIZE * 2;
export const CAP_STACK = 8;
export const CAP_CONTINUOUS = 32;
export const CAP_COMBAT = 32;
/** Upper bound on actions one `generateLegalActions` call can return. */
export const CAP_ACTIONS = 256;

// --- colors and mana ---------------------------------------------------------------

export const COLOR_W = 0;
export const COLOR_U = 1;
export const COLOR_B = 2;
export const COLOR_R = 3;
export const COLOR_G = 4;
export const NUM_COLORS = 5;
/** A mana pool is 5 colored slots plus colorless. */
export const POOL_SLOTS = NUM_COLORS + 1;
export const POOL_COLORLESS = NUM_COLORS;
/** A cost is `generic` plus one required-pip count per color. */
export const COST_GENERIC = 0;
export const COST_SLOTS = 1 + NUM_COLORS;

// --- card kinds --------------------------------------------------------------------

export const KIND_LAND = 0;
export const KIND_CREATURE = 1;
/** Deals `amount` damage to any target (creature or player). Sorcery-speed. */
export const KIND_BOLT = 2;
/** Instant. Gives target creature +amount/+amount until end of turn. */
export const KIND_PUMP = 3;

// --- keyword bitmask ---------------------------------------------------------------

export const KW_FLYING = 1;
export const KW_LIFELINK = 2;
export const KW_DEATHTOUCH = 4;
export const KW_VIGILANCE = 8;
export const KW_HASTE = 16;

// --- target restrictions -----------------------------------------------------------

export const TARGET_NONE = 0;
/** Any target — a creature on either battlefield, or either player. */
export const TARGET_ANY = 1;
/** A creature on either battlefield. */
export const TARGET_CREATURE = 2;

// --- timing ------------------------------------------------------------------------

export const TIMING_SORCERY = 0;
export const TIMING_INSTANT = 1;

// --- steps -------------------------------------------------------------------------
//
// The real engine has 12 steps; the model folds `beginCombat`/`endCombat` into their
// neighbours because they carry no rules the hot path exercises. Everything else is
// one-for-one, including a cleanup step that expires until-EOT effects.

export const STEP_UNTAP = 0;
export const STEP_UPKEEP = 1;
export const STEP_DRAW = 2;
export const STEP_MAIN1 = 3;
export const STEP_DECLARE_ATTACKERS = 4;
export const STEP_DECLARE_BLOCKERS = 5;
export const STEP_COMBAT_DAMAGE = 6;
export const STEP_MAIN2 = 7;
export const STEP_END = 8;
export const STEP_CLEANUP = 9;
export const NUM_STEPS = 10;

/** Steps that are sorcery-speed windows for the active player. */
export function isMainStep(step) {
  return step === STEP_MAIN1 || step === STEP_MAIN2;
}

// --- action kinds -------------------------------------------------------------------

export const ACT_PASS = 0;
export const ACT_PLAY_LAND = 1;
export const ACT_TAP_FOR_MANA = 2;
export const ACT_CAST_SPELL = 3;
export const ACT_DECLARE_ATTACKERS = 4;
export const ACT_DECLARE_BLOCKERS = 5;

/**
 * Attack/block declarations are COMPOSITE, exactly as they are in `packages/core`
 * (one action carrying the whole declaration), so the action space has the same
 * shape. Where the real engine offers one canonical declaration and lets a pilot
 * construct narrower ones itself, the model enumerates a small fixed menu instead
 * so that every arm picks from an identical list and nothing is decided outside
 * the measured code.
 */
export const ATTACK_ALL = 0;
export const ATTACK_PROFITABLE = 1;
export const BLOCK_NONE = 0;
export const BLOCK_GREEDY = 1;

/** Target encoding inside a packed action: 0..MAX_INSTANCES-1 = instance. */
export const TARGET_PLAYER_0 = MAX_INSTANCES;
export const TARGET_PLAYER_1 = MAX_INSTANCES + 1;
export const TARGET_NOTHING = MAX_INSTANCES + 2;

/**
 * Pack an action into one i32 so the flat arms can emit a legal-action list into a
 * preallocated buffer with ZERO allocation. Layout (low → high):
 *   kind 4 bits | instance 8 bits | target 9 bits | extra 4 bits
 */
export function packAction(kind, instanceId, target, extra) {
  return (kind & 0xf) | ((instanceId & 0xff) << 4) | ((target & 0x1ff) << 12) | ((extra & 0xf) << 21);
}
export function actKind(a) {
  return a & 0xf;
}
export function actInstance(a) {
  return (a >> 4) & 0xff;
}
export function actTarget(a) {
  return (a >> 12) & 0x1ff;
}
export function actExtra(a) {
  return (a >> 21) & 0xf;
}

// --- the card table -----------------------------------------------------------------
//
// Data, not code (rule 2). Every arm reads this same table; the flat arms read the
// integer projection below it.

/** @type {{name:string,kind:number,cost:number[],power:number,toughness:number,keywords:number,produces:number,amount:number,timing:number,target:number}[]} */
export const CARDS = [
  // --- lands (produces = color index) ---
  card('Plains', KIND_LAND, [0, 0, 0, 0, 0, 0], 0, 0, 0, COLOR_W, 0, TIMING_SORCERY, TARGET_NONE),
  card('Mountain', KIND_LAND, [0, 0, 0, 0, 0, 0], 0, 0, 0, COLOR_R, 0, TIMING_SORCERY, TARGET_NONE),
  card('Forest', KIND_LAND, [0, 0, 0, 0, 0, 0], 0, 0, 0, COLOR_G, 0, TIMING_SORCERY, TARGET_NONE),
  card('Island', KIND_LAND, [0, 0, 0, 0, 0, 0], 0, 0, 0, COLOR_U, 0, TIMING_SORCERY, TARGET_NONE),

  // --- creatures: generic, cost = [generic, W, U, B, R, G] ---
  card('Savannah Lions', KIND_CREATURE, [0, 1, 0, 0, 0, 0], 2, 1, 0, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Goblin Raider', KIND_CREATURE, [0, 0, 0, 0, 1, 0], 2, 1, KW_HASTE, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Grizzly Bears', KIND_CREATURE, [1, 0, 0, 0, 0, 1], 2, 2, 0, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Wind Drake', KIND_CREATURE, [2, 0, 1, 0, 0, 0], 2, 2, KW_FLYING, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Ronin Warclub', KIND_CREATURE, [1, 1, 0, 0, 0, 0], 2, 2, KW_VIGILANCE, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Spitting Drake', KIND_CREATURE, [2, 0, 0, 0, 1, 0], 3, 3, KW_FLYING, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Thorn Elemental', KIND_CREATURE, [4, 0, 0, 0, 0, 2], 5, 5, 0, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Serra Angel', KIND_CREATURE, [3, 2, 0, 0, 0, 0], 4, 4, KW_FLYING | KW_VIGILANCE, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Vampire Bat', KIND_CREATURE, [1, 0, 0, 1, 0, 0], 1, 1, KW_FLYING | KW_LIFELINK, -1, 0, TIMING_SORCERY, TARGET_NONE),
  card('Basilisk Cub', KIND_CREATURE, [1, 0, 0, 0, 0, 1], 1, 2, KW_DEATHTOUCH, -1, 0, TIMING_SORCERY, TARGET_NONE),

  // --- removal (any target) ---
  card('Lightning Bolt', KIND_BOLT, [0, 0, 0, 0, 1, 0], 0, 0, 0, -1, 3, TIMING_SORCERY, TARGET_ANY),
  card('Searing Spear', KIND_BOLT, [1, 0, 0, 0, 1, 0], 0, 0, 0, -1, 3, TIMING_SORCERY, TARGET_ANY),
  card('Char', KIND_BOLT, [2, 0, 0, 0, 1, 0], 0, 0, 0, -1, 4, TIMING_SORCERY, TARGET_ANY),

  // --- instants (targeted pump — the model's until-EOT continuous effect source) ---
  card('Giant Growth', KIND_PUMP, [0, 0, 0, 0, 0, 1], 0, 0, 0, -1, 3, TIMING_INSTANT, TARGET_CREATURE),
  card('Titanic Growth', KIND_PUMP, [1, 0, 0, 0, 0, 1], 0, 0, 0, -1, 4, TIMING_INSTANT, TARGET_CREATURE),
];

function card(name, kind, cost, power, toughness, keywords, produces, amount, timing, target) {
  return { name, kind, cost, power, toughness, keywords, produces, amount, timing, target };
}

export const NUM_CARDS = CARDS.length;

/** Column count in the flat card table. */
export const CARD_STRIDE = 1 /*kind*/ + COST_SLOTS + 1 /*power*/ + 1 /*toughness*/ + 1 /*keywords*/ + 1 /*produces*/ + 1 /*amount*/ + 1 /*timing*/ + 1 /*target*/;
export const CARD_KIND = 0;
export const CARD_COST = 1;
export const CARD_POWER = CARD_COST + COST_SLOTS;
export const CARD_TOUGHNESS = CARD_POWER + 1;
export const CARD_KEYWORDS = CARD_TOUGHNESS + 1;
export const CARD_PRODUCES = CARD_KEYWORDS + 1;
export const CARD_AMOUNT = CARD_PRODUCES + 1;
export const CARD_TIMING = CARD_AMOUNT + 1;
export const CARD_TARGET = CARD_TIMING + 1;

/** The integer projection of {@link CARDS}, shared verbatim by arms B and C. */
export function flatCardTable() {
  const t = new Int32Array(NUM_CARDS * CARD_STRIDE);
  for (let i = 0; i < NUM_CARDS; i++) {
    const c = CARDS[i];
    const o = i * CARD_STRIDE;
    t[o + CARD_KIND] = c.kind;
    for (let k = 0; k < COST_SLOTS; k++) t[o + CARD_COST + k] = c.cost[k];
    t[o + CARD_POWER] = c.power;
    t[o + CARD_TOUGHNESS] = c.toughness;
    t[o + CARD_KEYWORDS] = c.keywords;
    t[o + CARD_PRODUCES] = c.produces;
    t[o + CARD_AMOUNT] = c.amount;
    t[o + CARD_TIMING] = c.timing;
    t[o + CARD_TARGET] = c.target;
  }
  return t;
}

// --- decks ---------------------------------------------------------------------------

/**
 * Two fixed 60-card decks, expressed as counts per card index. Data, not code —
 * both are two-color so mana is a real constraint rather than a formality.
 */
const DECK_RG = [
  [1, 12], // Mountain
  [2, 11], // Forest
  [5, 4], // Goblin Raider
  [6, 4], // Grizzly Bears
  [9, 4], // Spitting Drake
  [10, 3], // Thorn Elemental
  [13, 4], // Basilisk Cub
  [14, 4], // Lightning Bolt
  [15, 4], // Searing Spear
  [16, 3], // Char
  [17, 4], // Giant Growth
  [18, 3], // Titanic Growth
];

const DECK_WU = [
  [0, 12], // Plains
  [3, 11], // Island
  [4, 4], // Savannah Lions
  [7, 4], // Wind Drake
  [8, 4], // Ronin Warclub
  [11, 3], // Serra Angel
  [12, 4], // Vampire Bat
  [6, 4], // Grizzly Bears (splash body)
  [5, 4], // Goblin Raider
  [14, 4], // Lightning Bolt
  [17, 3], // Giant Growth
  [16, 3], // Char
];

function expand(pairs) {
  const out = [];
  for (const [idx, n] of pairs) for (let i = 0; i < n; i++) out.push(idx);
  if (out.length !== DECK_SIZE) {
    throw new Error(`deck must be ${DECK_SIZE} cards, got ${out.length}`);
  }
  return out;
}

/** Deck for player 0 and player 1, as arrays of card indices (pre-shuffle). */
export const DECKS = [expand(DECK_RG), expand(DECK_WU)];

// --- RNG ------------------------------------------------------------------------------

/**
 * xorshift32. Chosen because it is EXACTLY reproducible across JavaScript and
 * AssemblyScript: every operation is a 32-bit integer op that `| 0` in JS and
 * `i32` in WASM agree on bit for bit. That is what lets the equivalence gate
 * compare full game transcripts across arms rather than just summary statistics.
 */
export function rngNext(s) {
  let x = s | 0;
  x ^= x << 13;
  x |= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x |= 0;
  return x;
}

/** A value in [0, n) from state `s`. Caller advances the state itself. */
export function rngBounded(s, n) {
  return ((s >>> 0) % n) | 0;
}

// --- transcript fingerprint -------------------------------------------------------------

/**
 * FNV-1a over the observable game trace. Every arm folds the SAME quantities in the
 * SAME order, so equal fingerprints prove the arms played identical games — the
 * technique `packages/ai/bench/mcts-bench.mjs` uses to prove a change is a pure
 * speedup rather than a behaviour change.
 */
export const FNV_OFFSET = 0x811c9dc5 | 0;
export function fnv(h, v) {
  let x = (h ^ (v | 0)) | 0;
  x = Math.imul(x, 0x01000193) | 0;
  return x;
}

/**
 * Actions that carry no card (pass, and the two composite combat declarations)
 * spell their instance field differently in an object graph (`-1`) than in a packed
 * integer (`0`). Both arms fold this normalized value instead of the raw field, so
 * the transcript compares the ACTION, not the encoding.
 */
export function digestInstance(kind, instanceId) {
  if (kind === ACT_PASS || kind === ACT_DECLARE_ATTACKERS || kind === ACT_DECLARE_BLOCKERS) return -1;
  return instanceId;
}
