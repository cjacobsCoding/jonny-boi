/**
 * MANUAL mana tapping for the hotseat — the pure half (DOM-free, unit-tested).
 *
 * Auto-tap (`GameSession.castWithAutoTap`) covers "I want to cast this"; it does
 * not cover the other half of playing Magic by hand: floating mana on purpose,
 * choosing WHICH source pays, and — the case that actually breaks without a
 * control — deciding what colour a MODAL source makes. Birds of Paradise taps for
 * "one mana of any colour", and a player who wants blue from it has no way to say
 * so if the only path is a planner that picks for them.
 *
 * The options are read straight off the engine's own `generateLegalActions`, which
 * already enumerates one `tapForMana` per legal mode with the right `mode` index.
 * Deriving them any other way would be a second, drift-prone answer to "what can
 * this permanent make right now?" — and would get summoning sickness wrong, which
 * the engine's menu gets right for free.
 */
import {
  manaAmountOf,
  manaExtrasOf,
  manaModesOf,
  scaleProduction,
  MANA_COLORS,
  type CardInstance,
  type GameAction,
  type InstanceId,
  type ManaColor,
  type PlayerId,
} from '@jonny-boi/core';

/**
 * The slice of the board this module reads. Typed as its own minimal shape rather
 * than as `GameState` so ONLINE play can pass the server's `MaskedGameView`: the
 * battlefield and the priority holder are public information, present verbatim in
 * both. Manual tapping is then one implementation for both seats' UIs instead of a
 * second, drift-prone answer to "what can this permanent make right now?".
 */
export interface ManaTapBoard {
  readonly battlefield: readonly CardInstance[];
  readonly priorityPlayer: PlayerId;
}

/** One way to tap one permanent: which mode, and what it makes. */
export interface ManaTapOption {
  readonly instanceId: InstanceId;
  /** The engine's mode index; `undefined` for a source with a single mode. */
  readonly mode: number | undefined;
  /** The colours this mode adds, in WUBRG+C order, with repeats for quantity. */
  readonly colors: readonly ManaColor[];
  /** A short label for the button ("G", "2 C", "W"). */
  readonly label: string;
}

/** Every legal way the priority-holder may tap, grouped by permanent. */
export type ManaTapMenu = ReadonlyMap<InstanceId, readonly ManaTapOption[]>;

/** Find a battlefield permanent by id (mana sources are always on the battlefield). */
function permanentById(state: ManaTapBoard, id: InstanceId): CardInstance | undefined {
  return state.battlefield.find((c) => c.instanceId === id);
}

/**
 * Describe one mode as its produced colours, e.g. `['C','C']` for a Sol Ring.
 *
 * §3.164 — a board-derived AMOUNT (Gaea's Cradle, Axebane Guardian) scales the
 * mode by the same reader the engine applies, so the button says "3 G" on the
 * board that makes three; a parley (Selvala) produces nothing the menu can
 * count before its reveal, so its one mode reads empty and is labelled below.
 */
function colorsOfMode(state: ManaTapBoard, card: CardInstance, mode: number | undefined): ManaColor[] {
  const modes = manaModesOf(card.def);
  const chosen = modes[mode ?? 0];
  if (!chosen) return [];
  const amountSpec = card.def.manaAbilities === undefined ? undefined : manaExtrasOf(card.def)?.[mode ?? 0]?.ability.amount;
  const production = amountSpec === undefined ? chosen : scaleProduction(chosen, manaAmountOf(state, card, amountSpec));
  const out: ManaColor[] = [];
  for (const color of MANA_COLORS) {
    const n = production[color] ?? 0;
    for (let i = 0; i < n; i++) out.push(color);
  }
  return out;
}

/** Whether this mode is a parley — its mana is decided by a reveal, not printed. */
function isParleyMode(card: CardInstance, mode: number | undefined): boolean {
  if (card.def.manaAbilities === undefined) return false;
  return manaExtrasOf(card.def)?.[mode ?? 0]?.ability.rider?.parley !== undefined;
}

/** "G", "2 C", or "—" when a mode somehow produces nothing (never in practice). */
function labelForColors(colors: readonly ManaColor[]): string {
  if (colors.length === 0) return '—';
  if (colors.length === 1) return colors[0] as string;
  const allSame = colors.every((c) => c === colors[0]);
  return allSame ? `${colors.length} ${colors[0]}` : colors.join('');
}

/**
 * Build the tap menu from the engine's legal actions. Only the priority-holder has
 * any (the engine only generates actions for them), so nothing here needs to
 * re-check whose turn it is.
 */
export function manaTapMenu(state: ManaTapBoard, actions: readonly GameAction[]): ManaTapMenu {
  const menu = new Map<InstanceId, ManaTapOption[]>();
  for (const action of actions) {
    if (action.kind !== 'tapForMana') continue;
    const card = permanentById(state, action.instanceId);
    if (!card) continue;
    const colors = colorsOfMode(state, card, action.mode);
    const option: ManaTapOption = {
      instanceId: action.instanceId,
      mode: action.mode,
      colors,
      // A parley's mana is whatever the reveal earns; the button says so
      // rather than showing the "—" of a mode that makes nothing.
      label: isParleyMode(card, action.mode) ? 'Parley' : labelForColors(colors),
    };
    const existing = menu.get(action.instanceId);
    if (existing) existing.push(option);
    else menu.set(action.instanceId, [option]);
  }
  return menu;
}

/**
 * True when tapping this permanent forces a decision (more than one mode), which
 * is exactly when the UI must ask instead of just tapping.
 */
export function isModalTap(options: readonly ManaTapOption[]): boolean {
  return options.length > 1;
}

/**
 * The ids the viewer may tap right now — the menu's keys, but only when the viewer
 * is the seat the engine generated the menu for. A menu belonging to the opponent's
 * priority window must never light up this seat's board.
 */
export function tappableIds(
  menu: ManaTapMenu,
  state: ManaTapBoard,
  viewer: PlayerId,
): ReadonlySet<InstanceId> {
  if (state.priorityPlayer !== viewer) return new Set();
  const ids = new Set<InstanceId>();
  for (const id of menu.keys()) {
    const card = permanentById(state, id);
    if (card && card.controller === viewer) ids.add(id);
  }
  return ids;
}
