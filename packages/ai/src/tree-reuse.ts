/**
 * TREE REUSE BETWEEN DECISIONS (`docs/plans/superhuman-ai-program.md` §21–22).
 *
 * The hybrid pilot builds a PUCT tree for one decision and then throws it away.
 * The brief's §21–22 says not to: promote the node matching what really happened
 * to be the new root, and create a fresh root only when nothing matches. This
 * module is the matching half — the part that has to be *right* — and the pilot
 * (`hybrid.ts`) owns the search that consumes it.
 *
 * ## Why matching is by POSITION, not by action
 *
 * The obvious reading of §21–22 is "remember which child edge we took, and when
 * the opponent moves, look up their action among that child's edges". That is
 * not implementable against this repo's pilot seam, for three separate reasons,
 * and all three vanish if the key is the position instead:
 *
 *  1. **A pilot is not told the opponent's ACTIONS.** `Pilot.chooseAction` is
 *     called only when *we* hold priority (`packages/sim/src/match.ts`). Between
 *     two of our decisions the opponent may take any number of actions.
 *     `Pilot.createGameObserver` (DESIGN §3.4c) has since opened an observation
 *     channel, but it reports spectator-level **events**, not the `GameAction` the
 *     opponent chose — deliberately, since an action payload can name cards from a
 *     hidden zone. So action-keyed reuse for §22 ("after opponent actions") is
 *     still not on the table, and reasons 2 and 3 below hold regardless of it.
 *     Position-keyed reuse needs nothing: the next position we are handed already
 *     encodes everything that happened.
 *  2. **The number of engine actions between two of our decisions is unbounded
 *     and mostly invisible.** The search compresses forced windows away
 *     (`advanceToDecision`), our own macros span several plies, and a committed
 *     macro can be abandoned half-way when the engine stops offering its next
 *     ply. "How many actions ago was the root" is not a number the pilot knows.
 *  3. **{@link actionEquivalenceKey} is the wrong key for this job — and the
 *     right key for the job it already does.** It answers "are these two offered
 *     actions the same DECISION", which is exactly what collapsing five
 *     interchangeable Islands into one candidate needs, and `prepareCandidates`
 *     rightly keys on it. It deliberately merges actions whose *states* differ
 *     (Island #7 and Island #12 tapped for {U} share a key but leave different
 *     permanents untapped). Reusing a subtree on that key would silently adopt a
 *     search of a position that is not the one on the table.
 *
 * So the retained tree is matched by a {@link PositionFingerprint}: a hash of the
 * whole game position. A node is reused only when its recorded position is the
 * live one. Everything §21–22 asks for follows — our own move, the opponent's
 * moves, and any run of forced actions in between are all just "the position
 * moved from here to there".
 *
 * ## Determinism (the property the Lab's paired A/B verdict rests on)
 *
 * Reuse makes a decision depend on what this pilot instance searched EARLIER.
 * That is safe here, and the reason is structural rather than a matter of care:
 *
 *  - Within one game, the sequence of positions a seat is asked about is a
 *    deterministic function of the game seed, the decks, and who is on the play.
 *    So the retained tree at every decision is too, and so is the decision.
 *  - Across games it can never leak, because `GameState.seed` is part of the
 *    fingerprint. A pilot instance reused for game 2 (which the CLI, the web
 *    Lab, and the sim harness all do) cannot match anything it learned in game 1
 *    — not "is unlikely to", *cannot*. This matters because the Lab shards games
 *    across workers by range (`RunOptions.range`, `PairedArmRunner.playSlice`),
 *    so which games precede which varies with the worker count. History-
 *    dependence that crossed a game boundary would make a verdict depend on how
 *    many cores the machine has.
 *  - The same pilot instance may serve BOTH seats (`pilot-quality.test.ts` does
 *    exactly this). Rewards are stored from one player's perspective, so a tree
 *    built for seat A must not be re-rooted for a seat-B decision; the retained
 *    tree records its decider and reuse requires it to match.
 *
 * Nothing here reads the clock or `Math.random`, and every walk is over arrays in
 * insertion order, so the result is reproducible on any machine.
 */

import type { CardInstance, GameState, ManaColor, PlayerId, Step } from '@jonny-boi/core';
import { MANA_COLORS, PLAYER_IDS, STEP_ORDER } from '@jonny-boi/core';

// --- the position fingerprint -----------------------------------------------------

/**
 * A hash of a whole game position, as two independent 32-bit values.
 *
 * Two accumulators rather than one: a single 32-bit hash collides at ~1 in 4
 * billion, which sounds ample until you notice the search asks the question a few
 * hundred times per decision for a whole gauntlet. Sixty-four bits puts a false
 * match far below the rate at which anything else in this system is wrong.
 *
 * A collision is a *strength* bug, never a crash or a determinism bug: the pilot
 * always rebuilds its root candidates from the live legal actions (see
 * `hybrid.ts`), so a wrongly-matched node can only ever contribute misleading
 * visit counts, never an illegal action.
 */
export interface PositionFingerprint {
  readonly a: number;
  readonly b: number;
}

export function fingerprintsEqual(x: PositionFingerprint, y: PositionFingerprint): boolean {
  return x.a === y.a && x.b === y.b;
}

/**
 * How many cards deep into each library the fingerprint looks.
 *
 * Library ORDER is not implied by the rest of the state: a "look at the top N and
 * reorder" effect changes it while every count and the RNG cursor stay put. But
 * hashing a whole 50-card library at every node would cost more than the reuse
 * saves, and every reordering effect in real Magic touches the top few cards. So
 * the top of each library is hashed exactly and the rest is covered by its
 * length. The failure mode of this compromise is a false MATCH after a deep
 * reorder, which costs a little accuracy — not a crash, and not reproducibility.
 */
const LIBRARY_TOP_DEPTH = 8;

// FNV-1a's 32-bit offset basis and prime, and a second, unrelated pair, so the
// two accumulators cannot fail together on structured input.
const HASH_A_BASIS = 0x811c9dc5;
const HASH_A_PRIME = 0x01000193;
const HASH_B_BASIS = 0xcbf29ce4;
const HASH_B_PRIME = 0x85ebca6b;

/**
 * Module-scope hashing accumulators.
 *
 * Deliberate: `fingerprintPosition` is called once per tree node created, on the
 * search's hot path, and a per-call accumulator object (or a closure per call)
 * would allocate there. JavaScript is single-threaded and nothing between
 * `beginHash()` and `endHash()` yields or re-enters, so a scratch pair is safe.
 */
let hashA = 0;
let hashB = 0;

function beginHash(): void {
  hashA = HASH_A_BASIS;
  hashB = HASH_B_BASIS;
}

function endHash(): PositionFingerprint {
  return { a: hashA >>> 0, b: hashB >>> 0 };
}

/** Fold one integer into both accumulators. */
function mix(value: number): void {
  const v = value | 0;
  hashA = Math.imul(hashA ^ v, HASH_A_PRIME);
  hashB = Math.imul(hashB + v + 1, HASH_B_PRIME) ^ (hashB >>> 13);
}

/** Fold a short string (a counter kind) in, character by character. */
function mixText(text: string): void {
  mix(text.length);
  for (let i = 0; i < text.length; i++) mix(text.charCodeAt(i));
}

/** Player ids as small integers — `PLAYER_IDS` is the canonical order. */
function playerCode(player: PlayerId | null | undefined): number {
  if (player == null) return 0;
  return PLAYER_IDS.indexOf(player) + 1;
}

function stepCode(step: Step): number {
  return STEP_ORDER.indexOf(step);
}

/**
 * Hash a whole position.
 *
 * ## What it covers, and why that is enough
 *
 * Card IDENTITY is never hashed — only `instanceId`. Instance ids are unique and
 * monotone within a game (`GameState.nextInstanceId`), so within the only scope
 * reuse can span, an id determines the card. `seed` is mixed in first, which is
 * what makes the whole thing game-scoped: two different games can never collide,
 * however similar their boards. That single line is what keeps a shared pilot
 * instance from leaking a tree across a game boundary.
 *
 * Everything that a rules-legal continuation could depend on is covered: the
 * clock fields (turn/step/priority/passes), both players' resources and zone
 * contents, every battlefield permanent's mutable state including counters and
 * attachments, the stack, combat, continuous effects, the pending choice, and the
 * RNG cursor — so two positions that agree here produce the same future under the
 * same actions. Libraries are the one deliberate approximation
 * ({@link LIBRARY_TOP_DEPTH}).
 */
export function fingerprintPosition(state: GameState): PositionFingerprint {
  beginHash();
  mix(state.seed);
  mix(state.rngState);
  mix(state.nextInstanceId);
  mix(state.turnNumber);
  mix(stepCode(state.step));
  mix(playerCode(state.activePlayer));
  mix(playerCode(state.priorityPlayer));
  mix(state.consecutivePasses);
  mix(state.gameOver ? 1 : 0);
  mix(playerCode(state.winner));

  for (let p = 0; p < PLAYER_IDS.length; p++) {
    const player = state.players[PLAYER_IDS[p] as PlayerId];
    if (!player) {
      mix(-1);
      continue;
    }
    mix(player.life);
    mix(player.hasLost ? 1 : 0);
    mix(player.landsPlayedThisTurn);
    // The land-drop ALLOWANCE, not just the count spent: two states that have
    // each played one land are genuinely different if one of them resolved an
    // Explore and may still play another. Without this the two hash identically
    // and tree reuse would hand back a subtree built for the wrong board.
    // `?? 0` keeps the hash byte-identical for every state that never touches
    // the field, which is almost all of them.
    mix(player.extraLandPlaysThisTurn ?? 0);
    for (let c = 0; c < MANA_COLORS.length; c++) mix(player.manaPool[MANA_COLORS[c] as ManaColor] ?? 0);
    mixInstanceIds(player.hand);
    mixInstanceIds(player.graveyard);
    mixInstanceIds(player.exile);
    mixInstanceIds(player.command);
    // Library: length exactly, plus the top few ids (see LIBRARY_TOP_DEPTH).
    const library = player.library;
    mix(library.length);
    const depth = library.length < LIBRARY_TOP_DEPTH ? library.length : LIBRARY_TOP_DEPTH;
    for (let i = 0; i < depth; i++) mix((library[i] as CardInstance).instanceId);
  }

  const battlefield = state.battlefield;
  mix(battlefield.length);
  for (let i = 0; i < battlefield.length; i++) {
    const perm = battlefield[i] as CardInstance;
    mix(perm.instanceId);
    mix(playerCode(perm.controller));
    mix((perm.tapped ? 1 : 0) | (perm.summoningSick ? 2 : 0) | (perm.markedByDeathtouch ? 4 : 0));
    mix(perm.damageMarked);
    mix(perm.attachedTo != null ? perm.attachedTo : -1);
    // `counters` is the shared frozen empty object for nearly every permanent, so
    // this loop almost always runs zero times.
    for (const kind in perm.counters) {
      mixText(kind);
      mix(perm.counters[kind] ?? 0);
    }
  }

  const stack = state.stack;
  mix(stack.length);
  for (let i = 0; i < stack.length; i++) {
    const obj = stack[i]!;
    mix(obj.instanceId);
    mix(playerCode(obj.controller));
    mix(obj.kind === 'spell' ? 1 : 2);
    const targets = obj.targets;
    mix(targets.length);
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t]!;
      mix(typeof target === 'number' ? target : -playerCode(target));
    }
  }

  const combat = state.combat;
  if (!combat) {
    mix(-1);
  } else {
    mix((combat.attackersDeclared ? 1 : 0) | (combat.blockersDeclared ? 2 : 0));
    mix(combat.attackers.length);
    for (let i = 0; i < combat.attackers.length; i++) mix(combat.attackers[i] as number);
    for (const blocker in combat.blocks) {
      mix(Number(blocker));
      mix(combat.blocks[blocker as unknown as number] as number);
    }
  }

  const continuous = state.continuous;
  mix(continuous.length);
  for (let i = 0; i < continuous.length; i++) {
    const effect = continuous[i]!;
    mix(effect.id);
    mix(effect.targetInstanceId);
    mix(effect.power ?? 0);
    mix(effect.toughness ?? 0);
    mix(effect.controlChange ? playerCode(effect.controlChange.to) : 0);
  }

  const choice = state.pendingChoice;
  mix(choice ? choice.id : -1);
  mix(choice ? playerCode(choice.chooser) : 0);

  return endHash();
}

function mixInstanceIds(cards: readonly CardInstance[]): void {
  mix(cards.length);
  for (let i = 0; i < cards.length; i++) mix((cards[i] as CardInstance).instanceId);
}

// --- the retained tree ------------------------------------------------------------

/**
 * The minimum a search tree must expose for this module to re-root it.
 *
 * Structural rather than importing `HybridNode`: the reuse machinery has no
 * business knowing about priors, movers or PUCT, and keeping it ignorant means a
 * future search (a tactical solver, §11) can reuse it without inheriting the
 * hybrid's node shape.
 */
export interface ReusableNode {
  readonly children: readonly ReusableEdge[];
  /** The position this node stands for, once the search has recorded it. */
  fingerprint?: PositionFingerprint;
  visits: number;
}

export interface ReusableEdge {
  node: ReusableNode | undefined;
  visits: number;
  totalReward: number;
}

/**
 * Find the node in a retained tree that stands for `target`, searching
 * breadth-first to `maxDepth` edges.
 *
 * Breadth-first so the SHALLOWEST match wins. That matters: a position can
 * genuinely recur deeper in the tree (a transposition), and the shallow node is
 * the one whose statistics were gathered closest to the line actually played.
 *
 * `maxDepth` bounds the work per decision. Real play only ever moves a decision
 * or two down the tree between two calls, so a small bound loses nothing and
 * keeps a deep tree from being re-walked in full.
 */
export function findNodeByFingerprint(
  root: ReusableNode,
  target: PositionFingerprint,
  maxDepth: number,
): ReusableNode | undefined {
  if (root.fingerprint && fingerprintsEqual(root.fingerprint, target)) return root;
  let frontier: ReusableNode[] = [root];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: ReusableNode[] = [];
    for (let i = 0; i < frontier.length; i++) {
      const children = (frontier[i] as ReusableNode).children;
      for (let c = 0; c < children.length; c++) {
        const child = (children[c] as ReusableEdge).node;
        if (!child) continue;
        if (child.fingerprint && fingerprintsEqual(child.fingerprint, target)) return child;
        next.push(child);
      }
    }
    frontier = next;
  }
  return undefined;
}

/**
 * Walk a retained subtree once, applying `decay` to every statistic and counting
 * the nodes. Returns the node count, or `-1` as soon as it exceeds `maxNodes`.
 *
 * ## Why decay is a knob and not a decision baked into the code
 *
 * A subtree's visit counts were accumulated under a different root — sometimes
 * several decisions ago, against an opponent model that has since been proved
 * wrong by what the opponent actually did. Reused as-is (`decay = 1`), those
 * counts have full authority over PUCT's exploration term and over the final
 * most-visited pick, so a line the search liked three decisions ago can win the
 * vote without being re-examined. Decayed, they are a prior the fresh search can
 * outvote. Which is better is an empirical question about this evaluator and this
 * budget, so it is a measured tunable, not an opinion — see
 * `HybridConfig.reuseDecay` and the `reuse` bench mode.
 *
 * Decay is applied to visits AND reward together, so every node's MEAN is
 * preserved exactly and only its CONFIDENCE is reduced. That is the property that
 * makes it a prior rather than a distortion.
 *
 * The bound is the memory answer: a retained tree that ever exceeds `maxNodes` is
 * dropped whole rather than trimmed, so the pilot's live footprint is capped by
 * construction and the cap is checked on the same walk that does the decay.
 */
export function decayAndCountSubtree(root: ReusableNode, decay: number, maxNodes: number): number {
  let count = 0;
  const stack: ReusableNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ReusableNode;
    count++;
    if (count > maxNodes) return -1;
    if (decay !== 1) node.visits = node.visits * decay;
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const edge = children[i] as ReusableEdge;
      if (decay !== 1) {
        edge.visits = edge.visits * decay;
        edge.totalReward = edge.totalReward * decay;
      }
      if (edge.node) stack.push(edge.node);
    }
  }
  return count;
}
