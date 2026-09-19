/**
 * INFINITE-COMBO DETECTION — the pure half (DESIGN §3.177, stage 1).
 *
 * > "if it detects that you have been stepping through what results as an
 * > infinite combo, it should do a pop up that highlights the infinite combo,
 * > and lets you agree to trigger it infinitely or not — it should also have
 * > options to only trigger it a specific amount of times — up to some large
 * > number limit" … "Some infinite combos dont actually yield an infinite
 * > change — like tapping an artifact to untap another, and tapping that one to
 * > untap the first — shouldn't be considered an infinite combo worth
 * > considering because there's no net infinite change."
 *
 * ## The model
 *
 * Every applied action (both seats') is recorded as a {@link ComboHistoryEntry}:
 * a canonical KEY for the action plus the {@link ComboSignature} of the state
 * after it. A signature is split in two, and the split IS the definition of an
 * infinite combo:
 *
 *  - `structure` — everything that must be IDENTICAL for the same actions to be
 *    legal again and do the same thing: the non-token permanents (definition,
 *    controller, tapped, summoning-sick, marked damage, attachment), the stack,
 *    whose turn and step, the graveyards and exiles, the declared combat;
 *  - `resources` — the counts a loop is allowed to MOVE: life, poison, mana by
 *    colour, cards in hand and library (per player), tokens per definition per
 *    controller, counters per permanent per kind.
 *
 * A {@link ComboLoop} is found when the last `k` actions (k ≤
 * {@link COMBO_MAX_CYCLE_ACTIONS}) equal the `k` before them, the structure at the
 * start and at the end of both cycles is one and the same, at least one resource
 * moved by the SAME non-zero delta over both cycles — the "net infinite change"
 * — and none of the owner's finite resources was SPENT by the cycle (see
 * {@link COMBO_RESOURCE_KINDS}: a loop that pays {1} per iteration from a
 * floating pool is a shortcut, not an infinite combo, and stops when the pool
 * does). Two artifacts untapping each other move nothing and are refused with
 * `noNetChange`, which leaves them to the CR 104.4b machinery exactly as today.
 *
 * ## Why BOTH players' actions are in the cycle
 *
 * In any real game an activated ability resolves only after both players pass,
 * so a human's loop against the computer reads `activate · pass · (opponent)
 * pass · …`. The opponent's passes are part of the demonstrated cycle, and
 * replaying them is precisely what a CR 727 shortcut is: the opponent, having
 * declined to interrupt two iterations, is taken to keep declining. A cycle in
 * which the OTHER player did anything but pass is refused (`sharedLoop`) — that
 * is not one player's loop, and stage 1 does not offer it.
 *
 * Pure: no engine imports beyond types, nothing here mutates a state.
 */
import type { GameAction } from './actions.js';
import type { CardInstance, GameState, InstanceId, PlayerId } from './state.js';
import { PLAYER_IDS } from './state.js';
import { MANA_COLORS } from './mana.js';

// --- the tunables ------------------------------------------------------------

/**
 * The longest cycle, in APPLIED ACTIONS (both seats'), the detector will name.
 *
 * Thirty, from the shape of the loops it is for: one activated ability costs
 * three actions in a real game (activate, pass, the opponent's pass), a
 * triggered ability with a target costs three more (the aim, and two passes
 * to resolve it), and a mana tap one. Three combo pieces with a trigger and a
 * couple of taps sit under thirty; anything longer is not something a player
 * "steps through" by hand.
 */
export const COMBO_MAX_CYCLE_ACTIONS = 30;

/**
 * How many history entries are kept: two full cycles plus the state BEFORE
 * them, which is what the first cycle's resource delta is measured against.
 */
export const COMBO_HISTORY_LENGTH = 2 * COMBO_MAX_CYCLE_ACTIONS + 1;

/**
 * The most iterations one `repeatCombo` may ask for.
 *
 * One thousand, for two reasons that pull the same way. It is decisive in any
 * real game — no life total, loyalty, toughness or token count a game of Magic
 * reaches survives a thousand iterations of a loop that moves it by one — and
 * it is cheap: every iteration is the recorded actions applied through the
 * ordinary `applyAction` funnel (triggers, state-based actions and the event
 * log included), and a thousand of a thirty-action cycle is thirty thousand
 * applications, which the Play board finishes well inside a second while the
 * log it produces stays renderable. "Infinitely" is stage 2's ∞ value, not a
 * bigger number here.
 */
export const COMBO_REPEAT_CAP = 1000;

/**
 * What the prompt's number field starts at. A hundred is "effectively forever"
 * for every loop a player is likely to want (a win, a wall of tokens, a life
 * total nothing reaches) while keeping the first click's event burst small; the
 * field goes up to {@link COMBO_REPEAT_CAP}.
 */
export const COMBO_REPEAT_DEFAULT = 100;

// --- resources: the closed table -----------------------------------------------

/** The kinds of count a loop is allowed to move. A CLOSED set — see the table. */
export type ComboResourceKind = 'life' | 'poison' | 'mana' | 'hand' | 'library' | 'tokens' | 'counters';

/**
 * WHAT a resource key's subject names, once resolved against a state: a token
 * definition's printed name, a counter kind and the permanent it sits on, a
 * mana colour. Empty for the per-player counts.
 */
export interface ComboSubject {
  readonly name: string;
  /** The permanent a counter sits on — counters are the one kind with a host. */
  readonly host?: string;
}

/** One row of {@link COMBO_RESOURCE_KINDS}. */
export interface ComboResourceRule {
  /**
   * Whether the OWNER of the loop losing this resource means the loop is
   * SPENDING it — paying life, spending mana, discarding, sacrificing tokens,
   * removing counters, drawing down a library. A loop that spends a finite
   * resource every iteration ends when the resource does, so it is not offered
   * as infinite. The opponent losing the same resource is the loop's EFFECT
   * (infinite damage, infinite discard) and never disqualifies it.
   */
  readonly fuelWhenOwnerLoses: boolean;
  /** The noun for the prompt: "+2 life", "+1 Saproling", "+1 {G}". */
  readonly label: (subject: ComboSubject, count: number) => string;
}

/**
 * THE resource table. Adding a resource the detector should watch is a row
 * here plus its projection in {@link comboSignatureOf}; nothing else branches
 * on the kind. Poison is the one kind an owner cannot spend — nothing pays
 * poison — so their own poison moving in either direction is an effect.
 */
export const COMBO_RESOURCE_KINDS: Readonly<Record<ComboResourceKind, ComboResourceRule>> = Object.freeze({
  life: { fuelWhenOwnerLoses: true, label: () => 'life' },
  poison: { fuelWhenOwnerLoses: false, label: (_subject, count) => plural(count, 'poison counter') },
  mana: { fuelWhenOwnerLoses: true, label: (colour) => `{${colour.name}}` },
  hand: { fuelWhenOwnerLoses: true, label: (_subject, count) => plural(count, 'card') + ' in hand' },
  library: { fuelWhenOwnerLoses: true, label: (_subject, count) => plural(count, 'card') + ' in library' },
  tokens: { fuelWhenOwnerLoses: true, label: (token) => token.name },
  counters: {
    fuelWhenOwnerLoses: true,
    label: (counter, count) =>
      plural(count, `${counter.name} counter`) + (counter.host !== undefined ? ` on ${counter.host}` : ''),
  },
});

function plural(count: number, noun: string): string {
  return Math.abs(count) === 1 ? noun : `${noun}s`;
}

/** The separator inside a resource key. Never appears in a player id or a colour. */
const KEY_SEPARATOR = '|';

/**
 * One resource key: `kind|player|subject`. The subject is empty for the
 * per-player counts, a colour for mana, a token definition id for tokens, and
 * `instanceId:counterKind` for counters. Encoded as a string so a signature's
 * resources are a plain record that `Object.keys` unions and a test can read.
 */
export function comboResourceKey(kind: ComboResourceKind, player: PlayerId, subject = ''): string {
  return `${kind}${KEY_SEPARATOR}${player}${KEY_SEPARATOR}${subject}`;
}

/** The three parts of a key. Refuses (returns null) anything not written by {@link comboResourceKey}. */
export function parseComboResourceKey(key: string): { kind: ComboResourceKind; player: PlayerId; subject: string } | null {
  const first = key.indexOf(KEY_SEPARATOR);
  const second = key.indexOf(KEY_SEPARATOR, first + 1);
  if (first < 0 || second < 0) return null;
  const kind = key.slice(0, first);
  const player = key.slice(first + 1, second);
  if (!(kind in COMBO_RESOURCE_KINDS) || (player !== 'A' && player !== 'B')) return null;
  return { kind: kind as ComboResourceKind, player, subject: key.slice(second + 1) };
}

// --- the signature -------------------------------------------------------------

/** The canonical projection of a state the detector compares. */
export interface ComboSignature {
  /** Must be byte-identical across the cycle boundaries — see the module note. */
  readonly structure: string;
  /** Counts keyed by {@link comboResourceKey}; a missing key reads as zero. */
  readonly resources: Readonly<Record<string, number>>;
}

/** One recorded step: the action that produced `signature`, or none for the baseline. */
export interface ComboHistoryEntry {
  readonly action: GameAction | null;
  /** {@link comboActionKey} of `action`; `null` on the baseline entry. */
  readonly actionKey: string | null;
  readonly signature: ComboSignature;
}

/** The structure line for one non-token permanent. */
function permanentLine(inst: CardInstance): string {
  return [
    inst.def.id,
    inst.controller,
    inst.tapped ? 'T' : 'U',
    inst.summoningSick ? 'S' : '',
    inst.damageMarked,
    inst.attachedTo ?? '',
  ].join(':');
}

/** Sorted definition ids of a zone — a multiset that ignores order. */
function zoneLine(cards: readonly CardInstance[]): string {
  return cards
    .map((c) => c.def.id)
    .sort()
    .join(',');
}

/**
 * Project a state onto its {@link ComboSignature}. Reads only; allocates the
 * strings and the record, which is why it runs only for sessions that asked
 * for detection (`RulesConfig.comboDetectionSeats`).
 */
export function comboSignatureOf(state: GameState): ComboSignature {
  const permanents: string[] = [];
  const resources: Record<string, number> = {};
  const tokenCounts = new Map<string, number>();
  for (const inst of state.battlefield) {
    if (inst.def.isToken === true) {
      const key = comboResourceKey('tokens', inst.controller, inst.def.id);
      tokenCounts.set(key, (tokenCounts.get(key) ?? 0) + 1);
    } else {
      permanents.push(permanentLine(inst));
    }
    for (const kind of Object.keys(inst.counters)) {
      const count = inst.counters[kind] ?? 0;
      if (count !== 0) resources[comboResourceKey('counters', inst.controller, `${inst.instanceId}:${kind}`)] = count;
    }
  }
  for (const [key, count] of tokenCounts) resources[key] = count;
  permanents.sort();

  const stack = state.stack
    .map((obj) =>
      obj.kind === 'spell'
        ? `spell:${obj.controller}:${obj.card.def.id}:${obj.targets.join(',')}`
        : `ability:${obj.controller}:${obj.sourceInstanceId}:${obj.label}:${obj.targets.join(',')}`,
    )
    .join(';');

  const zones: string[] = [];
  for (const pid of PLAYER_IDS) {
    const player = state.players[pid];
    zones.push(`gy:${pid}=${zoneLine(player.graveyard)}`, `ex:${pid}=${zoneLine(player.exile)}`);
    resources[comboResourceKey('life', pid)] = player.life;
    if ((player.poison ?? 0) !== 0) resources[comboResourceKey('poison', pid)] = player.poison ?? 0;
    resources[comboResourceKey('hand', pid)] = player.hand.length;
    resources[comboResourceKey('library', pid)] = player.library.length;
    for (const colour of MANA_COLORS) {
      const amount = player.manaPool[colour];
      if (amount !== 0) resources[comboResourceKey('mana', pid, colour)] = amount;
    }
  }
  const combat = state.combat
    ? `combat:${state.combat.attackers.join(',')}:${Object.entries(state.combat.blocks)
        .map(([b, a]) => `${b}>${a}`)
        .join(',')}`
    : 'combat:none';

  const structure = [
    `turn:${state.activePlayer}:${state.step}`,
    `bf:${permanents.join(';')}`,
    `stack:${stack}`,
    ...zones,
    combat,
  ].join('\n');
  return { structure, resources };
}

// --- action keys -------------------------------------------------------------------

/** JSON with every object's keys sorted, so two equal actions stringify equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The canonical key two actions are compared by. An `answerChoice` is compared
 * by WHAT was answered, never by its `choiceId`: the id is minted per question,
 * so the same answer to the same question in the next iteration carries a
 * different one.
 */
export function comboActionKey(action: GameAction): string {
  if (action.kind === 'answerChoice') {
    return stableStringify({ kind: action.kind, player: action.player, answer: action.answer });
  }
  return stableStringify(action);
}

/**
 * A key for the WHOLE cycle that every rotation of it shares. Once a loop has
 * been dismissed, the next action by hand makes the last 2k entries a rotation
 * of the same loop; without this the dismissal would be forgotten one action
 * later. The smallest rotation under string order is the representative.
 */
export function comboCycleKey(actionKeys: readonly string[]): string {
  let best: string | undefined;
  for (let start = 0; start < actionKeys.length; start++) {
    const rotated = [...actionKeys.slice(start), ...actionKeys.slice(0, start)].join('');
    if (best === undefined || rotated < best) best = rotated;
  }
  return best ?? '';
}

// --- the verdict -----------------------------------------------------------------

/** One resource the loop moves, per cycle. */
export interface ComboResourceDelta {
  readonly key: string;
  readonly kind: ComboResourceKind;
  readonly player: PlayerId;
  /** The change per cycle — never zero. */
  readonly delta: number;
  /** The prompt's phrase, from {@link describeComboDelta}: "+2 life", "+1 Saproling". */
  readonly label: string;
}

/** A found loop: what to replay, whose it is, and what one cycle changes. */
export interface ComboLoop {
  /** The player whose loop it is — the one who took every non-pass action in it. */
  readonly player: PlayerId;
  /** {@link comboCycleKey} of the cycle — the dismissal memory's unit. */
  readonly key: string;
  /** The k recorded actions of one cycle, oldest first, exactly as applied. */
  readonly cycle: readonly GameAction[];
  /** Every resource that moves, sorted by key. At least one entry. */
  readonly deltas: readonly ComboResourceDelta[];
}

/**
 * Why the last actions are NOT an infinite combo. A closed vocabulary so a test
 * can name the refusal it expects and a caller can never mistake one for another:
 *  - `noRepeat`        — no k ≤ the cap makes the last 2k actions two equal runs;
 *  - `noActor`         — the repeated run is passes only;
 *  - `sharedLoop`      — both players took non-pass actions in it;
 *  - `structureMoved`  — the board is not the same at the cycle boundaries (a
 *                        sacrifice, a card drawn onto the battlefield, damage);
 *  - `deltaDiffers`    — a resource moved by different amounts in the two cycles;
 *  - `noNetChange`     — every resource is back where it was (untap ↔ untap);
 *  - `consumesFuel`    — the owner spends a finite resource every cycle.
 */
export type ComboRefusal =
  | 'noRepeat'
  | 'noActor'
  | 'sharedLoop'
  | 'structureMoved'
  | 'deltaDiffers'
  | 'noNetChange'
  | 'consumesFuel';

export type ComboVerdict =
  | { readonly found: true; readonly loop: ComboLoop }
  | { readonly found: false; readonly reason: ComboRefusal };

/** How a delta reads in the prompt and the log. The ONE phrasing funnel. */
export function describeComboDelta(kind: ComboResourceKind, subject: ComboSubject, delta: number): string {
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${Math.abs(delta)} ${COMBO_RESOURCE_KINDS[kind].label(subject, delta)}`;
}

/** "+1 life, +1 Saproling per cycle" — the prompt's and the log's summary. */
export function summarizeComboLoop(loop: ComboLoop): string {
  return `${loop.deltas.map((d) => d.label).join(', ')} per cycle`;
}

/**
 * The prompt's noun for a resource's subject — a token definition's printed
 * name, a counter kind with the permanent it sits on. Read off the state the
 * loop was found in; a subject that has since left degrades to its id rather
 * than to nothing.
 */
function subjectOf(state: GameState, kind: ComboResourceKind, subject: string): ComboSubject {
  if (kind === 'tokens') {
    const token = state.battlefield.find((c) => c.def.isToken === true && c.def.id === subject);
    return { name: token ? token.def.name : subject };
  }
  if (kind === 'counters') {
    const colon = subject.indexOf(':');
    const instanceId = Number(subject.slice(0, colon)) as InstanceId;
    const host = state.battlefield.find((c) => c.instanceId === instanceId);
    return host ? { name: subject.slice(colon + 1), host: host.def.name } : { name: subject.slice(colon + 1) };
  }
  return { name: subject };
}

/** Whether every position's key is equal between the two runs. */
function runsMatch(entries: readonly ComboHistoryEntry[], from: number, k: number): boolean {
  for (let i = 0; i < k; i++) {
    const earlier = entries[from + i]!.actionKey;
    const later = entries[from + k + i]!.actionKey;
    if (earlier === null || later === null || earlier !== later) return false;
  }
  return true;
}

/**
 * Look for a loop in the recorded history. `state` is the state the LAST entry
 * describes; it is read only to name subjects in the deltas' labels.
 *
 * The smallest k wins: a two-action loop performed four times is reported as
 * the two-action loop, not as a four-action one.
 */
export function findComboLoop(
  history: readonly ComboHistoryEntry[],
  state: GameState,
  maxCycle: number = COMBO_MAX_CYCLE_ACTIONS,
): ComboVerdict {
  const n = history.length;
  let refusal: ComboRefusal | undefined;
  for (let k = 1; k <= maxCycle && 2 * k + 1 <= n; k++) {
    const start = n - 2 * k; // index of the first action of the first cycle
    if (!runsMatch(history, start, k)) continue;
    const s0 = history[start - 1]!.signature;
    const s1 = history[start + k - 1]!.signature;
    const s2 = history[n - 1]!.signature;
    const verdict = judgeCycle(history.slice(start + k, n), s0, s1, s2, state);
    if (verdict.found) return verdict;
    // The smallest repeating k is the one the player is actually stepping
    // through; its refusal is the informative one, kept over any larger k's.
    refusal ??= verdict.reason;
  }
  return { found: false, reason: refusal ?? 'noRepeat' };
}

/** Rule on one candidate cycle whose two runs already match action for action. */
function judgeCycle(
  cycle: readonly ComboHistoryEntry[],
  s0: ComboSignature,
  s1: ComboSignature,
  s2: ComboSignature,
  state: GameState,
): ComboVerdict {
  let owner: PlayerId | undefined;
  for (const entry of cycle) {
    const action = entry.action!;
    if (action.kind === 'passPriority') continue;
    if (owner === undefined) owner = action.player;
    else if (owner !== action.player) return { found: false, reason: 'sharedLoop' };
  }
  if (owner === undefined) return { found: false, reason: 'noActor' };
  if (s0.structure !== s1.structure || s1.structure !== s2.structure) {
    return { found: false, reason: 'structureMoved' };
  }

  const keys = new Set<string>([...Object.keys(s0.resources), ...Object.keys(s1.resources), ...Object.keys(s2.resources)]);
  const deltas: ComboResourceDelta[] = [];
  for (const key of [...keys].sort()) {
    const first = (s1.resources[key] ?? 0) - (s0.resources[key] ?? 0);
    const second = (s2.resources[key] ?? 0) - (s1.resources[key] ?? 0);
    if (first !== second) return { found: false, reason: 'deltaDiffers' };
    if (second === 0) continue;
    const parsed = parseComboResourceKey(key);
    if (!parsed) continue; // not a key this module wrote — nothing to say about it
    deltas.push({
      key,
      kind: parsed.kind,
      player: parsed.player,
      delta: second,
      label: describeComboDelta(parsed.kind, subjectOf(state, parsed.kind, parsed.subject), second),
    });
  }
  if (deltas.length === 0) return { found: false, reason: 'noNetChange' };
  for (const d of deltas) {
    if (d.player === owner && d.delta < 0 && COMBO_RESOURCE_KINDS[d.kind].fuelWhenOwnerLoses) {
      return { found: false, reason: 'consumesFuel' };
    }
  }
  return {
    found: true,
    loop: {
      player: owner,
      key: comboCycleKey(cycle.map((e) => e.actionKey!)),
      cycle: cycle.map((e) => e.action!),
      deltas,
    },
  };
}

// --- the window ---------------------------------------------------------------------

/**
 * An open COMBO WINDOW: the engine has found the loop and is waiting for its
 * owner to say how many times to run it, or to decline. Modelled as state, the
 * way a madness window is, because it narrows one player's legal actions to
 * exactly two and every consumer (the board, a replay, the online server)
 * already reads legality off the state.
 */
export interface ComboWindow {
  /** Whose loop, and therefore who alone may act on the window. */
  readonly owner: PlayerId;
  readonly loop: ComboLoop;
  /**
   * The priority holder and pass count the moment before the window opened.
   * Opening hands the floor to the owner so the prompt can be answered; a
   * dismissal puts both back exactly, and a repeat restores them before the
   * first replayed action, so the game the loop continues is the game that was
   * being played — a window that reset the pass count would turn the owner's
   * next pass from "advance the step" into "hand over priority".
   */
  readonly resume: { readonly priorityPlayer: PlayerId; readonly consecutivePasses: number };
}
