/**
 * `GameSession` — the single source of game truth for the hotseat client.
 *
 * It owns the authoritative engine `GameState` + the cumulative event log, exposes
 * the legal actions for whoever currently has priority, and advances the game via
 * `submitAction` (which calls the engine's pure `applyAction` and stores the new
 * state + appended events). The UI renders from the session and calls `submitAction`
 * / the convenience helpers; it never mutates state itself. Transport-agnostic: the
 * session doesn't know whether the seats are local or networked (that's the
 * `SeatTransport` seam) — it only models the rules of advancement.
 *
 * The session is an immutable-style controller: every mutating method returns a NEW
 * `GameSession` (so React state updates are clean and an illegal action that the
 * engine rejects leaves the previous session untouched). It is a thin, deterministic
 * wrapper over the engine — it adds NO rules of its own beyond client conveniences
 * (auto-tap to pay for a cast; London mulligan bottoming) that decompose into legal
 * engine actions or pre-game library manipulation.
 */
import {
  applyAction,
  canPay,
  emptyPool,
  generateLegalActions,
  isLand,
  type CardInstance,
  type EffectRegistry,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
  type ManaCost,
  type ManaPool,
  type PlayerId,
} from '@jonny-boi/core';
import {
  legalTargets,
  needsTarget,
  targetRequirement,
  type TargetOption,
  type TargetRequirement,
} from './targeting.js';

/** The result of submitting an action: the next session and any rejection reason. */
export interface SubmitResult {
  readonly session: GameSession;
  /** Set when the engine rejected the action (state unchanged); null on success. */
  readonly rejected: string | null;
  /** Events the action produced (empty on rejection apart from the reject event). */
  readonly events: readonly GameEvent[];
}

/** A castable card option, pre-checked for affordability and target needs. */
export interface CastOption {
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  readonly cost: ManaCost | undefined;
  /** Whether the card requires choosing a target before it can be cast. */
  readonly needsTarget: boolean;
  readonly requirement: TargetRequirement;
  /** True when the player can already pay the cost from their floating mana pool. */
  readonly affordableNow: boolean;
  /** True when, after auto-tapping untapped mana sources, the cost could be paid. */
  readonly affordableWithTap: boolean;
}

/**
 * The session is constructed from an already-created game (see setup.ts). Player
 * names + the registry are immutable for the life of the game.
 */
export class GameSession {
  private constructor(
    readonly state: GameState,
    readonly events: readonly GameEvent[],
    readonly registry: EffectRegistry,
    readonly names: Readonly<Record<PlayerId, string>>,
  ) {}

  /** Wrap a freshly-created game + its setup events. */
  static fromCreated(
    created: { state: GameState; events: readonly GameEvent[] },
    registry: EffectRegistry,
    names: Readonly<Record<PlayerId, string>>,
  ): GameSession {
    return new GameSession(created.state, [...created.events], registry, names);
  }

  /** The seat that currently holds priority (whose action menu to show). */
  get priorityPlayer(): PlayerId {
    return this.state.priorityPlayer;
  }

  /** True once the engine has decided the game. */
  get gameOver(): boolean {
    return this.state.gameOver;
  }

  /** The winner, or null (undecided or a draw). */
  get winner(): PlayerId | null {
    return this.state.winner;
  }

  /** Legal actions for the current priority-holder (the raw engine menu). */
  legalActions(): readonly GameAction[] {
    return generateLegalActions(this.state);
  }

  /**
   * Resolve an instance id to a display name across all zones + the stack (for the
   * event log / target labels). Unknown ids degrade to a readable placeholder.
   */
  nameOf = (id: InstanceId): string => {
    const inst = this.findInstance(id);
    return inst ? inst.def.name : `#${id}`;
  };

  /** A player id → their chosen seat name (for the log). */
  playerName = (player: PlayerId): string => this.names[player];

  /**
   * Submit a fully-formed engine action. Returns a new session (and a rejection
   * reason if the engine refused it, in which case state is unchanged). Never throws.
   */
  submit(action: GameAction): SubmitResult {
    const result = applyAction(this.state, action, undefined, this.registry);
    const reject = result.events.find((e) => e.type === 'actionRejected');
    if (reject && reject.type === 'actionRejected') {
      // Rejected: the engine returns a clone of the prior state; keep OUR state +
      // log unchanged so an illegal action can't corrupt the game.
      return { session: this, rejected: reject.reason, events: result.events };
    }
    const next = new GameSession(
      result.state,
      [...this.events, ...result.events],
      this.registry,
      this.names,
    );
    return { session: next, rejected: null, events: result.events };
  }

  /** Pass priority for the current priority-holder. */
  passPriority(): SubmitResult {
    return this.submit({ kind: 'passPriority', player: this.priorityPlayer });
  }

  /** Play a land from the priority-holder's hand. */
  playLand(instanceId: InstanceId): SubmitResult {
    return this.submit({ kind: 'playLand', player: this.priorityPlayer, instanceId });
  }

  /** Tap a single mana source the priority-holder controls. */
  tapForMana(instanceId: InstanceId): SubmitResult {
    return this.submit({ kind: 'tapForMana', player: this.priorityPlayer, instanceId });
  }

  /**
   * Cast a spell, auto-tapping untapped mana sources as needed to pay its cost, then
   * putting it on the stack with the chosen targets. This is the convenience the UI
   * uses so a player doesn't have to micro-tap lands: we only ever offer casts the
   * player can actually afford (see {@link castOptions}), and tapping decomposes into
   * the SAME legal `tapForMana` engine actions a manual player would submit.
   *
   * Returns the rejection reason if any step fails (state then unchanged from the
   * caller's perspective — we thread the session forward only on full success).
   */
  castWithAutoTap(instanceId: InstanceId, targets: readonly (InstanceId | PlayerId)[]): SubmitResult {
    const player = this.priorityPlayer;
    const card = this.state.players[player].hand.find((c) => c.instanceId === instanceId);
    if (!card) return { session: this, rejected: 'that card is not in your hand', events: [] };

    // Tap sources until the pool can pay the cost (or we run out). `working` threads
    // the immutable session forward across each tap; it intentionally starts at the
    // current session (this is the seed of the fold, not an alias for mutation).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let working: GameSession = this;
    const cost = card.def.cost;
    if (cost) {
      const guard = this.state.battlefield.length + 1; // bound the loop
      let taps = 0;
      while (!canPay(working.state.players[player].manaPool, cost) && taps < guard) {
        const source = working.untappedManaSource(player);
        if (!source) break;
        const tapped = working.tapForMana(source);
        if (tapped.rejected) break;
        working = tapped.session;
        taps += 1;
      }
      if (!canPay(working.state.players[player].manaPool, cost)) {
        return { session: this, rejected: 'not enough mana available to cast this spell', events: [] };
      }
    }

    const cast = working.submit({ kind: 'castSpell', player, instanceId, targets });
    if (cast.rejected) {
      // Roll back to the pre-tap session so a failed cast doesn't strand tapped lands.
      return { session: this, rejected: cast.rejected, events: cast.events };
    }
    return cast;
  }

  /** Declare attackers (active player). */
  declareAttackers(attackers: readonly InstanceId[]): SubmitResult {
    return this.submit({ kind: 'declareAttackers', player: this.priorityPlayer, attackers });
  }

  /** Declare blockers (defending player). */
  declareBlockers(blocks: readonly { blocker: InstanceId; attacker: InstanceId }[]): SubmitResult {
    return this.submit({ kind: 'declareBlockers', player: this.priorityPlayer, blocks });
  }

  /** The lands in the priority-holder's hand they may currently play (engine-gated). */
  playableLands(): InstanceId[] {
    return this.legalActions()
      .filter((a): a is Extract<GameAction, { kind: 'playLand' }> => a.kind === 'playLand')
      .map((a) => a.instanceId);
  }

  /**
   * The cast options for the priority-holder: every nonland in hand that is legal to
   * cast at the current timing AND that the player can pay for (now or after auto-
   * tapping). We compute affordability against the *potential* pool (current pool +
   * everything untapped could add) so an instant-speed trick during the opponent's
   * turn shows up even before mana is floated.
   */
  castOptions(): CastOption[] {
    const player = this.priorityPlayer;
    const hand = this.state.players[player].hand;
    const legal = this.legalActions();
    // Cards the engine already says are castable RIGHT NOW (pool already pays).
    const castableNow = new Set(
      legal
        .filter((a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell')
        .map((a) => a.instanceId),
    );
    const potential = this.potentialPool(player);
    const options: CastOption[] = [];
    for (const card of hand) {
      if (isLand(card.def)) continue;
      // Timing: a card is castable if the engine lists it now, OR it would be listed
      // once mana is floated — but timing legality (sorcery vs instant window) is the
      // same regardless of mana, so we approximate by: it's castable-now, OR it could
      // be afforded with a tap AND the engine would accept its timing. The simplest
      // honest signal: only surface a tap-to-afford option when the engine ALSO
      // surfaces at least the floor (we test timing by checking the now-set OR that
      // floating mana would make it appear). To avoid offering an out-of-timing cast,
      // we require that the card is castable-now whenever its cost is already paid;
      // for tap-to-afford we rely on the engine rejecting a bad-timing cast cleanly.
      const cost = card.def.cost;
      const affordableNow = castableNow.has(card.instanceId);
      const affordableWithTap = cost ? canPay(potential, cost) : true;
      // Only present a card whose timing the engine would currently allow. The engine
      // lists a card in `castSpell` only when timing is OK and the pool already pays;
      // when the pool doesn't yet pay we can't see timing directly, so we gate the
      // tap-to-afford offer on the card being instant-speed OR it being the active
      // player's main phase with an empty stack (the sorcery window).
      const timingOk = affordableNow || this.timingAllows(card, player);
      if (!timingOk) continue;
      if (!affordableNow && !affordableWithTap) continue;
      options.push({
        instanceId: card.instanceId,
        cardId: card.def.id,
        name: card.def.name,
        cost,
        needsTarget: needsTarget(card.def),
        requirement: targetRequirement(card.def),
        affordableNow,
        affordableWithTap,
      });
    }
    return options;
  }

  /** Legal target options for a card's requirement against the current state. */
  targetsFor(req: TargetRequirement): readonly TargetOption[] {
    return legalTargets(req, this.state, this.names);
  }

  /**
   * End the game by concession: `loser` concedes, so `winner` wins. The engine has
   * no concede action, so we set the result directly on a state clone and append the
   * standard loss/game-over events — the same shape the engine emits — so the log and
   * end screen read correctly. Idempotent if the game is already over.
   */
  concede(loser: PlayerId, winner: PlayerId): GameSession {
    if (this.state.gameOver) return this;
    const next = structuredClone(this.state) as GameState;
    next.players[loser].hasLost = true;
    next.winner = winner;
    next.gameOver = true;
    const events: GameEvent[] = [
      { type: 'playerLost', player: loser, reason: 'conceded the game' },
      { type: 'gameOver', winner },
    ];
    return new GameSession(next, [...this.events, ...events], this.registry, this.names);
  }

  // --- mulligan support (London style) -----------------------------------------

  /**
   * Replace the opening shuffle with a fresh one for `seed` (a re-mulligan). Returns
   * a brand-new session created from a fresh game — the caller supplies the new
   * created game (built with a derived seed) so the engine does the shuffle/draw.
   * Kept here as a static helper for symmetry; the PlayView orchestrates re-creation.
   */
  static remulligan(
    created: { state: GameState; events: readonly GameEvent[] },
    registry: EffectRegistry,
    names: Readonly<Record<PlayerId, string>>,
  ): GameSession {
    return GameSession.fromCreated(created, registry, names);
  }

  /**
   * Bottom `cards` from `player`'s hand to the bottom of their library — the London
   * mulligan "keep" step. This is a legal pre-game library manipulation (not an in-
   * game action), so we mutate a clone of state directly. Returns a new session.
   * Robust: ignores instance ids not in hand; bottoming more than the hand holds
   * simply bottoms the whole hand.
   */
  bottomCards(player: PlayerId, cards: readonly InstanceId[]): GameSession {
    const next = structuredClone(this.state) as GameState;
    const p = next.players[player];
    for (const id of cards) {
      const idx = p.hand.findIndex((c) => c.instanceId === id);
      if (idx < 0) continue;
      const [card] = p.hand.splice(idx, 1);
      if (card) {
        card.zone = 'library';
        p.library.push(card); // bottom of library
      }
    }
    return new GameSession(next, this.events, this.registry, this.names);
  }

  // --- internals ---------------------------------------------------------------

  /** Find a card instance by id anywhere (battlefield/zones/stack), or undefined. */
  private findInstance(id: InstanceId): CardInstance | undefined {
    const onBf = this.state.battlefield.find((c) => c.instanceId === id);
    if (onBf) return onBf;
    for (const pid of ['A', 'B'] as const) {
      const p = this.state.players[pid];
      for (const zone of [p.hand, p.graveyard, p.exile, p.library, p.command]) {
        const found = zone.find((c) => c.instanceId === id);
        if (found) return found;
      }
    }
    for (const obj of this.state.stack) {
      if (obj.kind === 'spell' && obj.instanceId === id) return obj.card;
    }
    return undefined;
  }

  /** An untapped mana source the player controls (the next one to auto-tap), or null. */
  private untappedManaSource(player: PlayerId): InstanceId | null {
    for (const perm of this.state.battlefield) {
      if (perm.controller === player && !perm.tapped && (perm.def.produces?.length ?? 0) > 0) {
        return perm.instanceId;
      }
    }
    return null;
  }

  /** The mana pool the player COULD have after tapping every untapped source. */
  private potentialPool(player: PlayerId): ManaPool {
    const pool: ManaPool = { ...emptyPool(), ...this.state.players[player].manaPool };
    for (const perm of this.state.battlefield) {
      if (perm.controller === player && !perm.tapped) {
        for (const color of perm.def.produces ?? []) {
          pool[color] += 1;
        }
      }
    }
    return pool;
  }

  /** Whether the card's casting timing is allowed for `player` right now. */
  private timingAllows(card: CardInstance, player: PlayerId): boolean {
    const isInstant = card.def.timing === 'instant' || card.def.types.includes('instant');
    if (isInstant) return true;
    // Sorcery-speed: the player's main phase, empty stack, they're active.
    const mainSteps = ['precombatMain', 'postcombatMain'];
    return (
      player === this.state.activePlayer &&
      mainSteps.includes(this.state.step) &&
      this.state.stack.length === 0
    );
  }
}
