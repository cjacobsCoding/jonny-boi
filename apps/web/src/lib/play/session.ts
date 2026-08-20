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
  backFaceCastZonesOf,
  canPay,
  castPermissionFor,
  generateLegalActions,
  hasCardGrants,
  hasCastableBackFace,
  isLand,
  planManaPayment,
  playableFaceOf,
  type CardDefinition,
  type CardInstance,
  type CastZone,
  type ChoiceAnswer,
  type EffectRegistry,
  type GameAction,
  type GameEvent,
  type GameState,
  type InstanceId,
  type ManaCost,
  type ManaTapPlan,
  type PendingChoice,
  type PlayerId,
} from '@jonny-boi/core';
import { HOTSEAT_CONFIG } from './play-config.js';
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

/**
 * The key a cast option is identified by — the instance AND the face, because a
 * split card offers TWO casts of one instance and they are afforded, targeted
 * and clicked independently. Instance id alone was enough until a card could be
 * cast two ways.
 */
function castKey(instanceId: InstanceId, face?: 'back'): string {
  return face === undefined ? `${instanceId}` : `${instanceId}:${face}`;
}

/** One castable half of a card in hand, with the face its action must name. */
interface CastableHalf {
  readonly card: CardInstance;
  readonly face?: 'back';
}

/**
 * The halves of a hand card that could be cast, each as an instance whose `def`
 * IS that half — so the option's name, cost and target requirement describe what
 * the button actually does. Reads the same accessors the engine's offer loop
 * reads, so the board cannot show a half the engine will refuse (an AFTERMATH
 * half, castable only from the graveyard, is not offered here).
 */
function castableHalvesOf(card: CardInstance): readonly CastableHalf[] {
  const def = card.def;
  const second = hasCastableBackFace(def) && backFaceCastZonesOf(def).includes('hand');
  if (def.frontFace === undefined && !second) return [{ card }];
  const halves: CastableHalf[] = [{ card: { ...card, def: playableFaceOf(def, 'front') as CardDefinition } }];
  if (second) halves.push({ card: { ...card, def: def.backFace as CardDefinition }, face: 'back' });
  return halves;
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
  /**
   * The zone this cast leaves from — omitted/'hand' for an ordinary cast,
   * `'graveyard'` for a flashback cast (whose `cost` above is the FLASHBACK
   * cost, since that is what the cast pays).
   */
  readonly fromZone?: CastZone;
  /**
   * Which HALF this option casts — `'back'` for a split card's right half, an
   * aftermath half, an adventure, or a defeated Siege's reward. Every field
   * above (name, cost, target requirement) already describes THAT half, so the
   * button says what clicking it does; the face has to ride along or the engine
   * casts the other one.
   */
  readonly face?: 'back';
}

/**
 * One CYCLING ability of a card in the priority-holder's hand, pre-checked for
 * affordability exactly as {@link CastOption} is — same two flags, same meaning,
 * so the board can present "cycle it" beside "play it" with one shape.
 */
export interface CycleOption {
  readonly instanceId: InstanceId;
  readonly cardId: string;
  readonly name: string;
  /** Which printed cycling ability (a card may print cycling AND landcycling). */
  readonly abilityIndex: number;
  /** The printed label, e.g. `Cycling {2}` / `Islandcycling {1}`. */
  readonly label: string;
  readonly cost: ManaCost;
  readonly affordableNow: boolean;
  readonly affordableWithTap: boolean;
}

/** One legal target choice for an activated ability, labeled for the UI. */
export interface AbilityTargetChoice {
  readonly target: InstanceId | PlayerId;
  readonly label: string;
}

/**
 * One activatable ability of a permanent the priority-holder controls, derived
 * ENTIRELY from the engine's legal-action menu — an ability the engine does not
 * offer (already used this turn, unpayable minus loyalty, wrong timing) simply
 * is not here, so the UI cannot present a dead control.
 */
export interface AbilityOption {
  /** The source permanent. */
  readonly instanceId: InstanceId;
  readonly sourceName: string;
  /** Index into the source's `CardDefinition.activated` list. */
  readonly abilityIndex: number;
  /** The printed label ("+1: Each player discards a card."). */
  readonly label: string;
  /** Legal target choices, or null when the ability takes no target. */
  readonly targets: readonly AbilityTargetChoice[] | null;
}

/**
 * Build the engine's declare-attackers action. Pure and exported for tests: entries
 * for ids that are NOT in `attackers` are dropped, and when no entry survives the
 * action carries NO `attackTargets` key at all — byte-identical to the pre-walker
 * action, so every existing consumer and replay stays untouched.
 */
export function buildDeclareAttackersAction(
  player: PlayerId,
  attackers: readonly InstanceId[],
  attackTargets?: Readonly<Record<InstanceId, InstanceId | PlayerId>>,
): Extract<GameAction, { kind: 'declareAttackers' }> {
  const attacking = new Set(attackers);
  const kept: Record<InstanceId, InstanceId | PlayerId> = {};
  let count = 0;
  for (const [key, value] of Object.entries(attackTargets ?? {})) {
    const attackerId = Number(key);
    if (!attacking.has(attackerId)) continue;
    kept[attackerId] = value;
    count += 1;
  }
  return count > 0
    ? { kind: 'declareAttackers', player, attackers, attackTargets: kept }
    : { kind: 'declareAttackers', player, attackers };
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

  /**
   * Lazily-computed derived views, memoized because a session is IMMUTABLE — every
   * action returns a new `GameSession`, so anything derived from `state` is stable
   * for this object's lifetime.
   *
   * This is not a micro-optimisation. `castOptions()` calls `legalActions()` once
   * itself and again for every card in hand (affordability planning), and the
   * React board re-derives both on every render, so an un-memoized session
   * recomputed the engine's whole legal-action set a dozen times per frame — and
   * `autoAdvancePriority` multiplies that by the number of windows it skips, which
   * was enough to visibly freeze the tab.
   */
  private memoLegalActions?: readonly GameAction[];
  private memoCastOptions?: CastOption[];
  private memoGraveyardCastOptions?: CastOption[];
  private memoExileCastOptions?: CastOption[];
  private memoCycleOptions?: CycleOption[];
  private memoAbilityOptions?: AbilityOption[];

  /** Legal actions for the current priority-holder (the raw engine menu). */
  legalActions(): readonly GameAction[] {
    return (this.memoLegalActions ??= generateLegalActions(this.state));
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

  /**
   * Tap a single mana source the priority-holder controls. `mode` chooses which
   * mana a MODAL source makes (an any-colour creature, a dual land); omit it for
   * a single-mode source like a basic land.
   */
  tapForMana(instanceId: InstanceId, mode?: number): SubmitResult {
    return this.submit({ kind: 'tapForMana', player: this.priorityPlayer, instanceId, mode });
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
  castWithAutoTap(
    instanceId: InstanceId,
    targets: readonly (InstanceId | PlayerId)[],
    fromZone: CastZone = 'hand',
    face?: 'back',
  ): SubmitResult {
    const player = this.priorityPlayer;
    const zone =
      fromZone === 'graveyard'
        ? this.state.players[player].graveyard
        : fromZone === 'exile'
          ? this.state.players[player].exile
          : this.state.players[player].hand;
    const card = zone.find((c) => c.instanceId === instanceId);
    if (!card) {
      return {
        session: this,
        rejected:
          fromZone === 'graveyard'
            ? 'that card is not in your graveyard'
            : fromZone === 'exile'
              ? 'that card is not in exile'
              : 'that card is not in your hand',
        events: [],
      };
    }

    // Tap sources until the pool can pay the cost (or we run out). `working` threads
    // the immutable session forward across each tap; it intentionally starts at the
    // current session (this is the seed of the fold, not an alias for mutation).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let working: GameSession = this;
    // A flashback cast pays the FLASHBACK cost — the engine's own rule at
    // `applyCastSpell`, mirrored so the auto-tap plans for what will be charged.
    // What this cast will actually be charged, mirroring `applyCastSpell` so the
    // auto-tap plans for what the engine will take:
    //  - a permission cast from exile may be FREE (a defeated Siege's reward);
    //  - a madness cast pays the madness cost;
    //  - a graveyard cast pays the flashback cost, EXCEPT an aftermath half,
    //    which pays its own printed cost and prints no flashback at all;
    //  - everything else pays the printed cost OF THE HALF being cast.
    const castDef = playableFaceOf(card.def, face) ?? card.def;
    const permission = fromZone === 'exile' ? castPermissionFor(this.state, card) : undefined;
    const cost =
      permission !== undefined
        ? permission.free
          ? undefined
          : castDef.cost
        : fromZone === 'graveyard'
          ? (face === 'back' ? castDef.cost : card.def.flashback)
          : fromZone === 'exile'
            ? card.def.madness
            : castDef.cost;
    if (cost) {
      const guard = this.state.battlefield.length + 1; // bound the loop
      let taps = 0;
      while (!canPay(working.state.players[player].manaPool, cost) && taps < guard) {
        const next = working.nextTapToward(player, cost);
        if (!next) break;
        const tapped = working.tapForMana(next.instanceId, next.mode);
        if (tapped.rejected) break;
        working = tapped.session;
        taps += 1;
      }
      if (!canPay(working.state.players[player].manaPool, cost)) {
        return { session: this, rejected: 'not enough mana available to cast this spell', events: [] };
      }
    }

    const cast = working.submit({
      kind: 'castSpell',
      player,
      instanceId,
      targets,
      ...(fromZone === 'hand' ? {} : { fromZone }),
      ...(face === undefined ? {} : { face }),
    });
    if (cast.rejected) {
      // Roll back to the pre-tap session so a failed cast doesn't strand tapped lands.
      return { session: this, rejected: cast.rejected, events: cast.events };
    }
    return cast;
  }

  /**
   * Declare attackers (active player). `attackTargets` optionally routes attackers
   * at a defending planeswalker (attacker id → walker instance id); an attacker
   * with no entry attacks the defending player, exactly as the engine defines it.
   * With no entries the submitted action is byte-identical to the pre-walker one.
   */
  declareAttackers(
    attackers: readonly InstanceId[],
    attackTargets?: Readonly<Record<InstanceId, InstanceId | PlayerId>>,
  ): SubmitResult {
    return this.submit(buildDeclareAttackersAction(this.priorityPlayer, attackers, attackTargets));
  }

  /** Declare blockers (defending player). */
  declareBlockers(blocks: readonly { blocker: InstanceId; attacker: InstanceId }[]): SubmitResult {
    return this.submit({ kind: 'declareBlockers', player: this.priorityPlayer, blocks });
  }

  /**
   * The question a resolving spell/ability is waiting on, or null. While this is
   * set the engine has already moved priority to `pendingChoice.chooser` and the
   * ONLY legal action is answering it, so the UI can key its whole prompt off this
   * one getter without re-deriving who may act.
   */
  get pendingChoice(): PendingChoice | null {
    return this.state.pendingChoice ?? null;
  }

  /**
   * Answer the outstanding choice. Goes through the ordinary `answerChoice` action
   * so the engine — not the client — validates the answer, names the choice by id
   * (a stale answer is refused, not misapplied), and resumes the half-finished
   * resolution. Rejected cleanly when nothing is pending.
   */
  answerChoice(answer: ChoiceAnswer): SubmitResult {
    const choice = this.pendingChoice;
    if (!choice) return { session: this, rejected: 'no choice is awaiting an answer', events: [] };
    return this.submit({
      kind: 'answerChoice',
      player: choice.chooser,
      choiceId: choice.id,
      answer,
    });
  }

  /**
   * Does the priority-holder have a real decision to make right now?
   *
   * Pass-and-play gates every transfer of control behind a "hand the device over"
   * screen, so a priority window with nothing in it is not neutral — it is a
   * physical interruption. MTG gives both players priority in *every* step, which
   * meant a handoff at upkeep, draw, each combat step and end step: ten-plus per
   * turn, nearly all of them for a window where the player could do nothing at all.
   *
   * A window is meaningful when the player can play a land, cast something (now or
   * after tapping), or make a combat declaration. Passing is not a choice, and
   * neither is tapping for mana with nothing to spend it on — mana pools empty at
   * end of step, so that mana is provably unspendable. When this returns false the
   * UI passes for the player rather than stopping the game to ask.
   */
  hasMeaningfulChoice(): boolean {
    // A parked question is ALWAYS a real decision — and the only legal action is
    // answering it, so auto-advance must stop here rather than try to pass.
    if (this.pendingChoice) return true;
    for (const action of this.legalActions()) {
      if (action.kind === 'passPriority' || action.kind === 'tapForMana') continue;
      return true; // playLand / castSpell / declareAttackers / declareBlockers
    }
    // Nothing castable off the floating pool, but maybe castable after tapping.
    return this.castOptions().length > 0;
  }

  /**
   * Pass priority repeatedly while the holder has no meaningful choice, returning
   * the session at the next window that actually needs a human (or the end of the
   * game). Returns `this` unchanged when the current window is already meaningful,
   * so a caller can set state unconditionally without causing a re-render loop.
   *
   * Bounded by `maxAutoAdvanceSteps`: a state where nobody ever has a choice (two
   * empty boards passing turns at each other) must not spin the UI. Hitting the
   * bound simply stops early and hands control back — the game stays legal.
   */
  autoAdvancePriority(maxPasses: number = HOTSEAT_CONFIG.maxAutoAdvanceSteps): GameSession {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let working: GameSession = this;
    for (let i = 0; i < maxPasses; i++) {
      if (working.gameOver || working.hasMeaningfulChoice()) break;
      const result = working.passPriority();
      if (result.rejected) break;
      working = result.session;
    }
    return working;
  }

  /** The lands in the priority-holder's hand they may currently play (engine-gated). */
  playableLands(): InstanceId[] {
    return this.legalActions()
      // Front face only: a modal DFC's back-face land play needs `face: 'back'`
      // on the submitted action, and `playLand(instanceId)` cannot carry it —
      // so the offer is withheld rather than rendered as a button that the
      // engine would reject. Named as a gap in COORDINATION.
      .filter((a): a is Extract<GameAction, { kind: 'playLand' }> => a.kind === 'playLand' && a.face === undefined)
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
    return (this.memoCastOptions ??= this.computeCastOptions());
  }

  private computeCastOptions(): CastOption[] {
    const player = this.priorityPlayer;
    const hand = this.state.players[player].hand;
    const legal = this.legalActions();
    // Cards the engine already says are castable RIGHT NOW (pool already pays).
    // Keyed by instance AND face: a split card offers two casts of one instance
    // and they are affordable independently.
    const castableNow = new Set(
      legal
        .filter((a): a is Extract<GameAction, { kind: 'castSpell' }> => a.kind === 'castSpell')
        .filter((a) => a.fromZone === undefined)
        .map((a) => castKey(a.instanceId, a.face === 'back' ? 'back' : undefined)),
    );
    const options: CastOption[] = [];
    for (const handCard of hand) {
      for (const half of castableHalvesOf(handCard)) {
      const card = half.card;
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
      const affordableNow = castableNow.has(castKey(card.instanceId, half.face));
      const affordableWithTap = this.canAffordWithTaps(player, cost);
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
        ...(half.face === undefined ? {} : { face: half.face }),
      });
      }
    }
    return options;
  }

  /**
   * The FLASHBACK cast options for the priority-holder: every card in their own
   * graveyard with a flashback cost that the current timing allows and that they
   * could pay for (now, from the pool — in which case the engine already offers
   * the cast — or after auto-tapping). Same shape as {@link castOptions} so the
   * board's cast flow (target pick → `castWithAutoTap`) serves both zones; the
   * `cost`/affordability here are computed against the FLASHBACK cost, which is
   * what the cast pays.
   */
  graveyardCastOptions(): CastOption[] {
    return (this.memoGraveyardCastOptions ??= this.computeGraveyardCastOptions());
  }

  private computeGraveyardCastOptions(): CastOption[] {
    const player = this.priorityPlayer;
    const legal = this.legalActions();
    // Flashback casts the engine already offers (the pool pays the flashback cost).
    const castableNow = new Set(
      legal
        .filter(
          (a): a is Extract<GameAction, { kind: 'castSpell' }> =>
            a.kind === 'castSpell' && a.fromZone === 'graveyard',
        )
        .map((a) => a.instanceId),
    );
    const options: CastOption[] = [];
    for (const card of this.state.players[player].graveyard) {
      // AFTERMATH: a right half printed "cast this spell only from your
      // graveyard" pays its OWN cost and prints no flashback, so it is a
      // separate option built from the half rather than from the card.
      if (hasCastableBackFace(card.def) && backFaceCastZonesOf(card.def).includes('graveyard')) {
        const half = card.def.backFace as CardDefinition;
        const halfCost = half.cost;
        const nowCastable = legal.some(
          (a) =>
            a.kind === 'castSpell' &&
            a.fromZone === 'graveyard' &&
            a.instanceId === card.instanceId &&
            a.face === 'back',
        );
        const withTap = this.canAffordWithTaps(player, halfCost);
        if (nowCastable || withTap) {
          options.push({
            instanceId: card.instanceId,
            cardId: half.id,
            name: half.name,
            cost: halfCost,
            needsTarget: needsTarget(half),
            requirement: targetRequirement(half),
            affordableNow: nowCastable,
            affordableWithTap: withTap,
            fromZone: 'graveyard',
            face: 'back',
          });
        }
      }
      const flashback = card.def.flashback;
      if (flashback === undefined || isLand(card.def)) continue;
      const affordableNow = castableNow.has(card.instanceId);
      if (!affordableNow && !this.timingAllows(card, player)) continue;
      const affordableWithTap = this.canAffordWithTaps(player, flashback);
      if (!affordableNow && !affordableWithTap) continue;
      options.push({
        instanceId: card.instanceId,
        cardId: card.def.id,
        name: card.def.name,
        cost: flashback,
        needsTarget: needsTarget(card.def),
        requirement: targetRequirement(card.def),
        affordableNow,
        affordableWithTap,
        fromZone: 'graveyard',
      });
    }
    return options;
  }

  /**
   * The MADNESS cast option, when a madness window of the priority-holder's is
   * open: the exiled card, castable for its madness cost.
   *
   * Same `CastOption` shape as the hand and graveyard lists, so the board's one
   * cast flow (target pick → `castWithAutoTap`) serves this zone too — and the
   * cost carried is the MADNESS cost, which is what the cast pays. A window
   * whose cost this board cannot fund still yields an option marked unaffordable
   * rather than nothing at all, because a player who cannot pay still has to be
   * told what they are declining.
   */
  exileCastOptions(): CastOption[] {
    return (this.memoExileCastOptions ??= this.computeExileCastOptions());
  }

  private computeExileCastOptions(): CastOption[] {
    const permissions = this.computePermissionCastOptions();
    const window = this.state.madnessWindow;
    if (!window || window.controller !== this.priorityPlayer) return permissions;
    const card = this.state.players[window.controller].exile.find(
      (c) => c.instanceId === window.instanceId,
    );
    const madness = card?.def.madness;
    if (!card || madness === undefined) return permissions;
    const castableNow = this.legalActions().some(
      (a) => a.kind === 'castSpell' && a.fromZone === 'exile' && a.instanceId === card.instanceId,
    );
    return [
      {
        instanceId: card.instanceId,
        cardId: card.def.id,
        name: card.def.name,
        cost: madness,
        needsTarget: needsTarget(card.def),
        requirement: targetRequirement(card.def),
        affordableNow: castableNow,
        affordableWithTap: this.canAffordWithTaps(window.controller, madness),
        fromZone: 'exile',
      },
      ...permissions,
    ];
  }

  /**
   * Casts of a card SITTING IN EXILE that it has explicit permission for — an
   * adventurer's creature half after its adventure resolved (CR 715.3d), or a
   * defeated Siege's reward (CR 310.4). Presented in the same shape as every
   * other cast option, so the board's existing exile row shows them with no new
   * component: a permission cast and a madness cast are both "a card in exile
   * you may cast right now".
   */
  private computePermissionCastOptions(): CastOption[] {
    const player = this.priorityPlayer;
    const state = this.state;
    if (!hasCardGrants(state)) return [];
    const legal = this.legalActions();
    const options: CastOption[] = [];
    for (const card of state.players[player].exile) {
      const permission = castPermissionFor(state, card);
      if (permission === undefined) continue;
      const castDef = playableFaceOf(card.def, permission.face);
      if (castDef === undefined || isLand(castDef)) continue;
      const cost = permission.free ? undefined : castDef.cost;
      const nowCastable = legal.some(
        (a) => a.kind === 'castSpell' && a.fromZone === 'exile' && a.instanceId === card.instanceId,
      );
      const withTap = this.canAffordWithTaps(player, cost);
      if (!nowCastable && !withTap) continue;
      options.push({
        instanceId: card.instanceId,
        cardId: castDef.id,
        name: castDef.name,
        cost,
        needsTarget: needsTarget(castDef),
        requirement: targetRequirement(castDef),
        affordableNow: nowCastable,
        affordableWithTap: withTap,
        fromZone: 'exile',
        ...(permission.face === 'back' ? { face: 'back' as const } : {}),
      });
    }
    return options;
  }

  /**
   * The CYCLING options for the priority-holder: every printed cycling ability of
   * every card in their hand they could pay for, now or after auto-tapping.
   *
   * Not derived from `legalActions` alone, for the same reason the cast lists are
   * not: the engine offers a cycling action only once the pool ALREADY covers the
   * cost, so a board of untapped lands would show nothing. `affordableNow`
   * carries the engine's own offer; `affordableWithTap` is the auto-tap promise
   * {@link cycleWithAutoTap} then keeps.
   */
  cycleOptions(): CycleOption[] {
    return (this.memoCycleOptions ??= this.computeCycleOptions());
  }

  private computeCycleOptions(): CycleOption[] {
    const player = this.priorityPlayer;
    const offered = new Set(
      this.legalActions()
        .filter((a): a is Extract<GameAction, { kind: 'cycleCard' }> => a.kind === 'cycleCard')
        .map((a) => `${a.instanceId}:${a.abilityIndex ?? 0}`),
    );
    const options: CycleOption[] = [];
    for (const card of this.state.players[player].hand) {
      const abilities = card.def.cycling;
      if (!abilities) continue;
      for (let index = 0; index < abilities.length; index++) {
        const ability = abilities[index] as NonNullable<(typeof abilities)[number]>;
        const affordableNow = offered.has(`${card.instanceId}:${index}`);
        const affordableWithTap = this.canAffordWithTaps(player, ability.cost);
        if (!affordableNow && !affordableWithTap) continue;
        options.push({
          instanceId: card.instanceId,
          cardId: card.def.id,
          name: card.def.name,
          abilityIndex: index,
          label: ability.label,
          cost: ability.cost,
          affordableNow,
          affordableWithTap,
        });
      }
    }
    return options;
  }

  /**
   * Cycle a card from hand, auto-tapping for its cycling cost first — the same
   * convenience (and the same rollback-on-failure contract) `castWithAutoTap`
   * gives a cast, so a player never has to micro-tap lands to cycle.
   */
  cycleWithAutoTap(instanceId: InstanceId, abilityIndex = 0): SubmitResult {
    const player = this.priorityPlayer;
    const card = this.state.players[player].hand.find((c) => c.instanceId === instanceId);
    const ability = card?.def.cycling?.[abilityIndex];
    if (!ability) {
      return { session: this, rejected: 'that card has no such cycling ability', events: [] };
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let working: GameSession = this;
    const guard = this.state.battlefield.length + 1;
    let taps = 0;
    while (!canPay(working.state.players[player].manaPool, ability.cost) && taps < guard) {
      const next = working.nextTapToward(player, ability.cost);
      if (!next) break;
      const tapped = working.tapForMana(next.instanceId, next.mode);
      if (tapped.rejected) break;
      working = tapped.session;
      taps += 1;
    }
    if (!canPay(working.state.players[player].manaPool, ability.cost)) {
      return { session: this, rejected: 'not enough mana available to cycle this card', events: [] };
    }
    const cycled = working.submit({ kind: 'cycleCard', player, instanceId, abilityIndex });
    // Roll back to the pre-tap session so a failed cycle doesn't strand lands.
    if (cycled.rejected) return { session: this, rejected: cycled.rejected, events: cycled.events };
    return cycled;
  }

  /** Legal target options for a card's requirement against the current state. */
  targetsFor(req: TargetRequirement): readonly TargetOption[] {
    return legalTargets(req, this.state, this.names);
  }

  /**
   * The activatable abilities of the priority-holder's permanents, grouped from
   * the engine's own offers (one offered action per legal target folds into one
   * option carrying its target menu). Driven by `legalActions`, NOT by
   * `def.activated` — a loyalty ability already used this turn, or a minus the
   * walker cannot pay, is simply absent because the engine never offered it.
   */
  abilityOptions(): readonly AbilityOption[] {
    return (this.memoAbilityOptions ??= this.computeAbilityOptions());
  }

  private computeAbilityOptions(): AbilityOption[] {
    const byAbility = new Map<string, AbilityOption>();
    for (const action of this.legalActions()) {
      if (action.kind !== 'activateAbility') continue;
      const key = `${action.instanceId}:${action.abilityIndex}`;
      const source = this.findInstance(action.instanceId);
      const printed = source?.def.activated?.[action.abilityIndex];
      const existing = byAbility.get(key);
      const offeredTarget = action.targets?.[0];
      if (offeredTarget === undefined) {
        // A bare offer: no target to choose.
        if (!existing) {
          byAbility.set(key, {
            instanceId: action.instanceId,
            sourceName: source?.def.name ?? `#${action.instanceId}`,
            abilityIndex: action.abilityIndex,
            label: printed?.label ?? `Ability ${action.abilityIndex + 1}`,
            targets: null,
          });
        }
        continue;
      }
      const choice: AbilityTargetChoice = {
        target: offeredTarget,
        label:
          offeredTarget === 'A' || offeredTarget === 'B'
            ? `${this.names[offeredTarget]} (player)`
            : this.nameOf(offeredTarget),
      };
      byAbility.set(key, {
        instanceId: action.instanceId,
        sourceName: source?.def.name ?? `#${action.instanceId}`,
        abilityIndex: action.abilityIndex,
        label: printed?.label ?? `Ability ${action.abilityIndex + 1}`,
        targets: [...(existing?.targets ?? []), choice],
      });
    }
    return [...byAbility.values()];
  }

  /**
   * Activate a permanent's ability with the chosen targets (empty for a target-less
   * ability). Submits the SAME action shape the engine offered, so the engine —
   * not the client — remains the validator.
   */
  activateAbility(
    instanceId: InstanceId,
    abilityIndex: number,
    targets: readonly (InstanceId | PlayerId)[] = [],
  ): SubmitResult {
    return this.submit({
      kind: 'activateAbility',
      player: this.priorityPlayer,
      instanceId,
      abilityIndex,
      ...(targets.length > 0 ? { targets } : {}),
    });
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

  /**
   * The next tap toward paying `cost`, or null when the pool already covers it or
   * the board cannot. Delegates to core's shared planner, which is also what the
   * AI pilots use — so auto-tap picks the right COLOURS and stops as soon as the
   * cost is met, instead of grabbing whatever permanent came first.
   */
  private nextTapToward(player: PlayerId, cost: ManaCost): ManaTapPlan | null {
    const plan = planManaPayment(this.state, player, cost, this.legalActions());
    return plan && plan.length > 0 ? (plan[0] as ManaTapPlan) : null;
  }

  /**
   * Can `player` pay `cost` by tapping what they have untapped right now?
   *
   * Asks the shared planner rather than approximating with a "potential pool".
   * A pool cannot express a modal source — an any-colour Bird is one mana of a
   * colour you choose, and summing its modes claims five. Planning answers the
   * real question exactly, and respects summoning sickness because the candidate
   * taps come from the engine's own legal actions.
   */
  private canAffordWithTaps(player: PlayerId, cost: ManaCost | undefined): boolean {
    if (!cost) return true;
    return planManaPayment(this.state, player, cost, this.legalActions()) !== undefined;
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
