import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { actionBarHint } from '../../lib/play/action-hints.js';
import { groupJailedByJailer, jailSourcesOf } from '../../lib/play/jail-view.js';
import {
  describeTargetSetWithOwners,
  makeRefIndex,
  type KnownRef,
} from '../../lib/play/option-labels.js';
import type {
  CardDefinition,
  CardInstance,
  CastZone,
  GameAction,
  InstanceId,
  PlayerId,
} from '@jonny-boi/core';
import { isPlaneswalker, isPlayerTarget, PLAYER_IDS } from '@jonny-boi/core';
import { COMBAT_HOLD_CONFIG, stepLabel } from '../../lib/play/play-config.js';
import { maskedViewToBoardView } from '../../lib/online/board-adapter.js';
import { eligibleBlockerIds, NO_ELIGIBLE_BLOCKERS } from '../../lib/play/view-model.js';
import { castSequence, castableWithTaps, graveyardCastableWithTaps } from '../../lib/online/auto-tap.js';
import { alreadyPassedFrame, shouldAutoPassNow } from '../../lib/online/auto-pass.js';
import {
  combatHoldDecision,
  combatWindowFactsOf,
  NO_BEATS_SPENT,
  type CombatHoldKind,
} from '../../lib/play/combat-hold.js';
import { CombatHoldBanner } from '../play/CombatHoldBanner.js';
import { RevealBanner } from '../play/RevealBanner.js';
import { SpellHoldCard } from '../play/SpellHoldCard.js';
import { ForcedChoiceBanner } from '../play/ForcedChoiceBanner.js';
import {
  AnnouncementSurface,
  type AnnouncementRenderers,
} from '../play/AnnouncementSurface.js';
import { announcementQueue, type AnnouncementBody } from '../../lib/play/announcements.js';
import { usePrefersReducedMotion, useTileRects } from '../play/AnimationLayer.js';
import {
  BoardScene,
  useBoardSceneVars,
  type CombatDraft,
  type DamageSource,
} from '../play/BoardScene.js';
import { DRAG_ID_ATTR, useDragToPlay } from '../../lib/play/useDragToPlay.js';
import { idleTurnNote, reasonCardIsDisabled } from '../../lib/online/why-disabled.js';
import { zonePanelView } from '../../lib/play/zone-panel.js';
import { AUTO_PASS_DELAY_MS, AUTO_PASS_EMPTY_PRIORITY } from '../../lib/online/online-config.js';
import { legalTargets, optionToTarget, targetRequirement } from '../../lib/play/targeting.js';
import { buildDeclareAttackersAction, type AbilityOption } from '../../lib/play/session.js';
import type { GameFrame } from '../../lib/online/online-state.js';
import {
  abilityChoices,
  castChoices,
  declareAttackersAction,
  declareBlockersAction,
  exileCastChoices,
  graveyardCastChoices,
  passAction,
  playableLandIds,
  type CastChoice,
} from '../../lib/online/legal-actions.js';
import { answerChoiceAction, onlineChoiceView } from '../../lib/online/pending-choice.js';
import { isModalTap, manaTapMenu, tappableIds, type ManaTapOption } from '../../lib/play/mana-tap.js';
import { ChoicePrompt } from '../play/ChoicePrompt.js';
import {
  AbilityMenuPrompt,
  AbilityTargetPrompt,
  type AbilityPromptFaces,
} from '../play/AbilityPrompts.js';
import { ZonePanel } from '../play/ZonePanel.js';
import { type PermInteraction } from '../play/SeatPanel.js';
import { StackPanel } from '../play/StackPanel.js';
import { stackEntries } from '../../lib/play/stack-view.js';
import { PlayCard } from '../play/PlayCard.js';
import { CardFace } from '../play/CardFace.js';
import { CardHover } from '../CardHover.js';
import { CardZoomOverlay, type ZoomedCard } from '../play/CardZoomOverlay.js';
import '../play/action-bar.css';

/**
 * The in-game board for ONLINE play. It renders the server-pushed `MaskedGameView`
 * (adapted to the shared `BoardView`) and offers ONLY the server's `legalActions` —
 * so an illegal move can't be built. On a choice it calls `onAction(GameAction)`,
 * which the hook serializes to `submitAction`. Unlike hotseat there is NO device
 * handoff: when it's not our turn we render a clear "Waiting for opponent…" state.
 *
 * The BATTLEFIELD ITSELF is `BoardScene` — the same component `PlayBoard` mounts,
 * not a second arrangement of the same leaves. Everything else it reuses
 * (`StackPanel`, `PlayCard`, `ChoicePrompt`, `AbilityPrompts`, `ZonePanel`,
 * `CardFace`, `CardZoomOverlay`, `CombatHoldBanner`) it reuses verbatim; the
 * adapter and the pure `legal-actions` derivations are the only new glue. Every
 * affordance the hotseat board has is present here too (walker attacks, loyalty
 * abilities, flashback from the graveyard), driven off the masked view instead of
 * a local engine: a mechanic that ships must not be invisible online. The game
 * log uses the server's lines, handed to the scene as its rail.
 *
 * ## §3.143 wave 2 — the online board gets the overhaul too
 *
 * Wave 1 built the stack of real card faces (UX-1), the hover funnel (UX-10) and
 * the card face (UX-17) and wired them into `PlayBoard` ALONE, because the online
 * board was nobody's lane. Reusing a component is not the same as reaching a
 * screen: this file was still passing `nameOf={() => 'card'}` and no `faceOf`,
 * so the online stack rendered a column of placeholders labelled "card", and the
 * hand was the one hand in the app you could not hover. What reaches this board
 * now is everything that needs no server change:
 *
 *  - **UX-1/UX-2** — `stackEntries` (the SHARED producer, not a third hand-rolled
 *    `stackView`) over `masked.stack`, which the protocol sends unredacted and
 *    documents as public ("Battlefield + stack are public"), so real faces here
 *    reveal nothing the wire did not already carry;
 *  - **UX-10** — the hand and every target row go through `CardHover`;
 *  - **UX-8/UX-17** — the target prompt shows the SOURCE as a `CardFace`.
 *
 * ## THE SCENE — UX-9, UX-12, UX-13 and UX-14, and NOT as four ports
 *
 * Those four reached the hotseat board alone and would have been ported here one
 * at a time forever, because there was no unit to mount: the tilt wrapper, the
 * midline the advance clamp measures against, the staged copies and the arcs all
 * lived inline in `PlayBoard`'s JSX. `BoardScene` is that unit, and this board
 * mounting it is the whole of how they arrive. `online-board-parity.test.ts`
 * compares the two boards' scene skeletons element for element, so a fifth
 * feature cannot ship to one of them again.
 *
 * ⚠️ WHAT DOES NOT REACH IT, AND WHY — two limits, both real, neither papered over.
 *
 * 1. `CardFace`'s provenance half (UX-17.1–3) needs core's
 *    `explainCharacteristics`, which needs the full `GameState` and the
 *    continuous-effect index. An online client has neither — it holds a masked
 *    view, by design — so the faces here carry printed truth plus the glossary,
 *    and the board must not invent attribution to fill the gap. See
 *    `board-adapter.ts`'s `NO_MOD` note: the same limit, already stated once.
 * 2. ~~UX-15 (damage travelling from source to recipient)~~ — CLOSED. It needed
 *    the engine's `GameEvent` stream, which the `state` message did not carry;
 *    the protocol now sends the PUBLIC half of it (`PUBLIC_EVENT_KINDS`,
 *    filtered per seat by `maskEventsForSeat`) beside the prose log, and the
 *    scene is fed from `frame.events` below. It was a missing channel and not a
 *    masking limit, exactly as the note that stood here said — combat damage is
 *    public by the rules, and the server was already narrating it to both seats.
 */
/**
 * WHY A CARD ON THIS BOARD SHOWS NO PROVENANCE — said out loud, once.
 *
 * `CardFace` draws an empty breakdown as "nothing is modifying this", which is a
 * DIFFERENT and false claim here: this client has a masked view, so it cannot
 * know. Named rather than typed at each of the three mount sites that need it.
 *
 * ⚠️ The same sentence is spelled out in `lib/play/provenance-view.ts`'s
 * `unavailable` bench sample and in two test files. This is the only PRODUCTION
 * copy; the report for this lane asks lane-P's owner to export one constant from
 * `provenance-view.ts` and have all four import it.
 */
const PROVENANCE_UNAVAILABLE_ONLINE = 'Live provenance is not carried by the multiplayer protocol yet.';

/**
 * What the action bar says while the board is advancing a window FOR the player.
 *
 * Named and exported because two readers must agree on it: the bar that shows it
 * and `online-board-parity.test.ts`, which uses its presence and its ABSENCE as
 * the two-sided evidence that the §10 combat hold really stops the auto-passer.
 * A hard-coded copy in the test would go vacuous the day the wording changed.
 */
export const AUTO_ADVANCING_HINT = 'Nothing to do this step — advancing…';

export function OnlineBoard({
  frame,
  names,
  onAction,
  onConcede,
}: {
  frame: GameFrame;
  names: Readonly<Record<PlayerId, string>>;
  onAction: (action: GameAction) => void;
  onConcede: () => void;
}): ReactElement {
  const { view: masked, legalActions, yourTurn, log } = frame;
  const view = useMemo(() => maskedViewToBoardView(masked, names), [masked, names]);
  const step = masked.step;

  /**
   * EVERY INSTANCE THIS SEAT IS ENTITLED TO SEE, by id — the one place this
   * board answers *"what is #7 called?"* and *"which face does #7 show?"*.
   *
   * It is built ONLY from what the server already sent this viewer: the public
   * battlefield, both public graveyards, the exiles the mask already filtered
   * (a face-down foretold card is never in another seat's view), the public
   * stack, and the viewer's OWN hand. There is deliberately no path here to an
   * opponent's hand or library — the mask does not carry them, so no amount of
   * UI wanting a prettier card can widen what a viewer sees. That is the whole
   * reason this is a projection of `masked` rather than a lookup the board
   * assembles from somewhere else.
   *
   * One map, two questions, because the callers ask them separately: `nameOf`
   * is TOTAL (an unknown id degrades to a readable `#id`) and `faceOf` is
   * PARTIAL by nature (a token has no pool card; `null` means "no face", never
   * "guess one") — the exact contract `StackSources` documents.
   */
  const instanceIndex = useMemo(() => {
    const index = new Map<InstanceId, CardInstance>();
    const add = (cards: readonly CardInstance[]): void => {
      for (const card of cards) index.set(card.instanceId, card);
    };
    add(masked.battlefield);
    for (const pid of PLAYER_IDS) {
      add(masked.players[pid].graveyard);
      add(masked.players[pid].exile);
    }
    // A spell ON the stack is its own card instance (core builds the stack
    // object with `instanceId: card.instanceId`), and it is in no zone list.
    for (const obj of masked.stack) if (obj.kind === 'spell') index.set(obj.instanceId, obj.card);
    add(masked.players[masked.viewer].hand ?? []);
    return index;
  }, [masked]);

  const nameOfInstance = useCallback(
    (id: InstanceId): string => instanceIndex.get(id)?.def.name ?? `#${id}`,
    [instanceIndex],
  );
  const faceOfInstance = useCallback(
    (id: InstanceId): string | null => instanceIndex.get(id)?.def.id ?? null,
    [instanceIndex],
  );

  /**
   * The stack, TOP-FIRST, with the face each object shows — from the SHARED
   * producer, not from `view.stack`.
   *
   * `board-adapter.stackView()` predates UX-1 and carries neither a face nor a
   * source name, which is why this board could only ever pass
   * `nameOf={() => 'card'}`. Delegating to `stackEntries` is the two-line change
   * `lib/play/stack-view.ts` asks both adapters for; doing it HERE rather than
   * in the adapter keeps this wave inside one lane's files, and the adapter's
   * `StackView` remains for the consumers that still read it.
   */
  const stackFacts = useMemo(
    () => stackEntries(masked.stack, { nameOf: nameOfInstance, faceOf: faceOfInstance }),
    [masked.stack, nameOfInstance, faceOfInstance],
  );

  const lands = useMemo(() => playableLandIds(legalActions), [legalActions]);
  const casts = useMemo(() => castChoices(legalActions), [legalActions]);
  /** Flashback casts the server is ALREADY offering (its pool covers the cost). */
  const graveyardCasts = useMemo(() => graveyardCastChoices(legalActions), [legalActions]);
  /**
   * Casts OUT OF EXILE the server is offering — a madness window, a free
   * suspend/cascade window, an adventure's creature half, a defeated Siege's
   * reward. The server's own offers and nothing else; this board re-derives no
   * legality.
   *
   * ⚠️ NO tap-to-fund twin, unlike the graveyard's. `castableWithTaps` plans a
   * payment against a PRINTED cost, and the cost of a cast from exile is the
   * one the permission or the window names (a madness cost, or free) — which
   * this board cannot read off the instance. So exile offers exactly what the
   * server already offers, and a cast the viewer could only afford after tapping
   * stays absent rather than being offered and rejected. Reported as a known
   * narrowing, not approximated.
   */
  const exileCasts = useMemo(() => exileCastChoices(legalActions), [legalActions]);
  const attackTemplate = useMemo(() => declareAttackersAction(legalActions), [legalActions]);
  const blockTemplate = useMemo(() => declareBlockersAction(legalActions), [legalActions]);
  const pass = useMemo(() => passAction(legalActions), [legalActions]);
  // A resolving card parked a question. The server masks it per seat, so the board
  // either has the real question to render or only a line naming who is answering.
  const { answerable: ownChoice, waitingText } = useMemo(
    () => onlineChoiceView(masked, names),
    [masked, names],
  );

  // Manual mana tapping, from the SAME pure menu the hotseat board uses. Without a
  // way to tap, the server never offers a `castSpell` (it only lists spells the
  // floating pool already covers), so online play could not cast anything at all —
  // and a card that asks a question could never be reached.
  const tapMenu = useMemo(() => manaTapMenu(masked, legalActions), [masked, legalActions]);
  const tappable = useMemo(() => tappableIds(tapMenu, masked, masked.viewer), [tapMenu, masked]);

  // Cards the server hasn't offered a cast for yet, but which we could pay for by
  // tapping. Without this the online seat can never cast anything at all: the
  // server only lists `castSpell` once the pool already covers the cost, and this
  // board has no other way to tap a land.
  /** The viewer's own hand instances (present only for their own seat). */
  const handCardOf = (id: InstanceId): CardInstance | undefined =>
    (masked.players[masked.viewer].hand ?? []).find((c) => c.instanceId === id);

  /** The viewer's graveyard instances (a PUBLIC zone — always present, both seats). */
  const ownGraveyard = masked.players[masked.viewer].graveyard;
  const graveyardCardOf = (id: InstanceId): CardInstance | undefined =>
    ownGraveyard.find((c) => c.instanceId === id);

  const tapCastable = useMemo(
    () => castableWithTaps(masked, masked.viewer, masked.players[masked.viewer].hand ?? [], legalActions),
    [masked, legalActions],
  );

  /** The sorcery-speed window, from public facts the masked view already carries. */
  const sorceryWindowOpen =
    masked.activePlayer === masked.viewer &&
    (step === 'precombatMain' || step === 'postcombatMain') &&
    masked.stack.length === 0;

  /** Flashback casts we could fund by tapping first (the server lists none of these). */
  const graveyardTapCastable = useMemo(
    () => graveyardCastableWithTaps(masked, masked.viewer, ownGraveyard, legalActions, sorceryWindowOpen),
    [masked, ownGraveyard, legalActions, sorceryWindowOpen],
  );

  // Transient interaction state.
  const [pendingCast, setPendingCast] = useState<CastChoice | null>(null);
  /** Taps that must be sent before the pending cast (empty for an offered cast). */
  const [pendingTaps, setPendingTaps] = useState<readonly GameAction[]>([]);
  /** A modal source the player tapped BY HAND, awaiting the colour they want. */
  const [pendingManaTap, setPendingManaTap] = useState<readonly ManaTapOption[] | null>(null);
  const [chosenAttackers, setChosenAttackers] = useState<Set<InstanceId>>(new Set());
  /** attacker → the defending planeswalker it attacks (absent = attacks the player). */
  const [walkerAssign, setWalkerAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  /** A permanent whose activated-ability menu is open (a walker's loyalty lines). */
  const [abilitySource, setAbilitySource] = useState<InstanceId | null>(null);
  /** An ability chosen from that menu, awaiting its target choice. */
  const [pendingAbility, setPendingAbility] = useState<AbilityOption | null>(null);
  const [blockAssign, setBlockAssign] = useState<Map<InstanceId, InstanceId>>(new Map());
  const [activeBlockTarget, setActiveBlockTarget] = useState<InstanceId | null>(null);
  /**
   * The card being inspected full-size, if any (report 20260825_210026).
   *
   * {@link ZoomedCard}, not `{cardId, name}` — see §3.143 GAP-C. This board can
   * never fill in the provenance half (below), but it CAN say so rather than
   * showing a breakdown-shaped hole.
   */
  const [zoomed, setZoomed] = useState<ZoomedCard | null>(null);
  /** The viewer's graveyard panel (the flashback affordance's entry point). */
  // Which seat's graveyard is open, or none (bug report 20260907_190210).
  const [graveyardOpen, setGraveyardOpen] = useState<PlayerId | null>(null);
  /**
   * WHOSE exile is open, or null — the same seat-valued state the hotseat board
   * keeps, because a jailed or suspended card sits in its OWNER's exile and
   * either side is worth looking at. See `PlayBoard.tsx` for the reasoning; the
   * two boards share the panel, so they must share the affordance too.
   */
  const [exileOpen, setExileOpen] = useState<PlayerId | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  /** A transient board message (the hotseat board's toast, same feel). */
  const flash = (message: string): void => {
    setToast(message);
    window.setTimeout(() => setToast(null), TOAST_MS);
  };

  const reset = (): void => {
    setPendingCast(null);
    setPendingTaps([]);
    setPendingManaTap(null);
    setChosenAttackers(new Set());
    setWalkerAssign(new Map());
    setBlockAssign(new Map());
    setActiveBlockTarget(null);
    setAbilitySource(null);
    setPendingAbility(null);
  };

  const submit = (action: GameAction): void => {
    reset();
    onAction(action);
  };

  /**
   * Send an ordered sequence (taps, then the cast). The server applies messages in
   * order, so each tap is legal on arrival and the cast is legal once the last one
   * lands. It still validates every one — a rejection just stops the sequence.
   */
  const submitSequence = (actions: readonly GameAction[]): void => {
    reset();
    for (const action of actions) onAction(action);
  };

  /**
   * §10 — HOLDING COMBAT ON SCREEN, ON THIS BOARD TOO.
   *
   * The hotseat board measured the defect and fixed it; the online board has the
   * same combat and had the same invisibility, because it has its OWN advance
   * path (the auto-pass below) and got no hold. The decision itself is not
   * re-made here: `combatHoldDecision` and its closed `COMBAT_HOLD_KINDS` table
   * are the one answer both boards read, and `combatWindowFactsOf` adapts the
   * state unchanged — the protocol carries `combat` as core's own
   * `CombatState`, so there is nothing to translate.
   *
   * ⚠️ DERIVED DURING RENDER, not armed in an effect. The frame is pushed by the
   * server and the hold is a pure function of it, so there is never a render in
   * which the board has the frame but not yet the beat — which is the render the
   * auto-pass effect would have spent a pass in. It is also what lets
   * `online-board-parity.test.ts` see the banner at all: that suite renders to
   * static markup, where effects never run.
   */
  const reducedMotion = usePrefersReducedMotion();
  /**
   * Beats this turn's combat has already spent, and WHOSE turn it was.
   *
   * ⚠️ Compared at READ time rather than cleared by a reset effect — the same
   * rule `PlayView` records: a reset that lands between renders would book the
   * NEXT turn's combat as already held, which is the invisible-combat bug again
   * in a new hat. One combat phase per turn (`STEP_ORDER`), so the turn number
   * is the combat's identity.
   */
  const [beatsSpent, setBeatsSpent] = useState<{
    readonly turn: number;
    readonly spent: ReadonlySet<CombatHoldKind>;
  }>({ turn: 0, spent: NO_BEATS_SPENT });

  const combatHoldDecisionNow = combatHoldDecision(
    {
      step,
      combat: combatWindowFactsOf(masked.combat),
      spent: beatsSpent.turn === masked.turnNumber ? beatsSpent.spent : NO_BEATS_SPENT,
      reducedMotion,
      // The server's own verdict, carried by the mask — not a guess, and not the
      // `false` a board could get away with here because the online flow swaps
      // to `EndScreen` on `gameOver`.
      gameOver: masked.gameOver,
    },
    COMBAT_HOLD_CONFIG,
  );
  const combatHold = combatHoldDecisionNow.kind === 'hold' ? combatHoldDecisionNow.hold : null;

  /**
   * Book a beat, which is what ENDS it: the decision then refuses `alreadyHeld`
   * and the board resumes. Expiring and pressing Skip are the same event, so
   * there is one funnel for both (`PlayView`'s `releaseCombatHold` twin).
   *
   * Takes the turn as an ARGUMENT and updates functionally, so it closes over
   * nothing and stays referentially stable — the beat's timer below is keyed on
   * primitives precisely so a re-render cannot restart the beat it is timing.
   */
  const bookCombatBeat = useCallback((kind: CombatHoldKind, turn: number): void => {
    setBeatsSpent((current) => {
      const spent = new Set(current.turn === turn ? current.spent : []);
      spent.add(kind);
      return { turn, spent };
    });
  }, []);

  const holdKind = combatHold?.kind ?? null;
  const holdMs = combatHold?.ms ?? 0;
  const holdTurn = masked.turnNumber;
  useEffect(() => {
    if (holdKind === null) return undefined;
    const handle = window.setTimeout(() => bookCombatBeat(holdKind, holdTurn), holdMs);
    return () => window.clearTimeout(handle);
    // ⚠️ PRIMITIVES ONLY. `combatHold` is a fresh object every render, and a
    // frame arriving mid-beat (the opponent passing, a log line) would clear and
    // re-arm this timer forever — a beat that never ends is a hung game, not a
    // long pause.
  }, [holdKind, holdMs, holdTurn, bookCombatBeat]);

  /**
   * THE ANNOUNCEMENT QUEUE for this board. One entry today — see the mount at
   * the bottom of the render for why it goes through the queue anyway.
   */
  const announcements = useMemo(
    () =>
      announcementQueue([
        combatHold ? ({ kind: 'combatHold', hold: combatHold } as AnnouncementBody) : null,
      ]),
    [combatHold],
  );

  /**
   * HOW THIS BOARD DRAWS EACH ANNOUNCEMENT. A mapped type over every kind, so a
   * fifth announcement fails to compile on BOTH boards at once rather than
   * landing on one and missing the other (§3.143 GAP-20, the defect that made
   * `CombatHoldBanner` its own module in the first place).
   *
   * ⚠️ THREE OF THESE CANNOT FIRE ON THIS BOARD TODAY, and that is stated rather
   * than hidden: `OnlineBoard` never constructs a spell-hold, settled-choice or
   * reveal body, because the protocol carries a masked STATE and the seat-masked
   * event stream is not yet folded into any of the three (§11/§12). They draw the
   * SAME shared components the hotseat board draws, with the facts this board
   * genuinely has — a spell hold here names no targets because this board cannot
   * yet know them, which is an honest empty rather than an invented one.
   */
  const announcementRenderers: AnnouncementRenderers = useMemo(
    () => ({
      combatHold: (body) => (
        <CombatHoldBanner
          hold={body.hold}
          onSkip={() => bookCombatBeat(body.hold.kind, masked.turnNumber)}
        />
      ),
      spellHold: (body) => (
        <SpellHoldCard
          hold={body.hold}
          name={nameOfInstance(body.hold.instanceId)}
          cardId={faceOfInstance(body.hold.instanceId)}
          explanation={undefined}
          targets={[]}
          opponentName={names[body.hold.controller]}
        />
      ),
      forcedChoice: (body) => <ForcedChoiceBanner forced={body.forced} chosen={[]} />,
      reveal: (body) => <RevealBanner reveal={body.reveal} onDismiss={() => undefined} />,
    }),
    [bookCombatBeat, masked.turnNumber, nameOfInstance, faceOfInstance, names],
  );

  /**
   * Advance automatically through priority windows where passing is the ONLY legal
   * action. Without this a new game opens in `upkeep` and needs four `Pass / advance`
   * clicks (two per seat, through `upkeep` and `draw`) before the first land can be
   * played — with the whole hand greyed out and the bar still reading "Your move".
   *
   * `passedFrame` rate-limits it to once per server-pushed frame: a re-render must
   * not spend a second pass, but a NEW frame in the same step legitimately may (see
   * `alreadyPassedFrame` for the declareBlockers case that rules out a step key).
   *
   * ⚠️ THE LOAD-BEARING GATE (§10) is the second argument to
   * `shouldAutoPassNow`. This is the online analogue of the hotseat's
   * `shouldStop` predicate — the value that decides "should I keep advancing?" —
   * and the hold belongs INSIDE it rather than as an early return around the
   * effect, so nothing else can read a stale "yes". It is enough on its own
   * because the server is authoritative and has no auto-advance of its own: it
   * moves only when a seat's client submits, and the opponent's client is this
   * same component holding the same beat.
   */
  const passedFrame = useRef<GameFrame | null>(null);
  const autoPass =
    AUTO_PASS_EMPTY_PRIORITY &&
    !!pass &&
    shouldAutoPassNow(
      {
        yourTurn,
        legalActions,
        stackSize: masked.stack.length,
        awaitingOwnChoice: !!ownChoice,
        // A flashback the seat could fund is a real play, exactly like a hand card —
        // auto-passing over it would make the new affordance unreachable in the very
        // windows the card is castable in.
        tapCastableCount: tapCastable.size + graveyardTapCastable.size,
      },
      combatHold !== null,
    );

  useEffect(() => {
    if (!autoPass || !pass) return;
    if (alreadyPassedFrame(passedFrame.current, frame)) return;
    const handle = window.setTimeout(() => {
      // Mark the frame only once the pass actually GOES OUT. Marking it at
      // schedule time instead deadlocks under StrictMode's double-invoke: the
      // first run marks and schedules, the cleanup cancels the timer, and the
      // second run sees the mark and declines to reschedule — so the game sits
      // saying "advancing…" forever.
      passedFrame.current = frame;
      onAction(pass);
    }, AUTO_PASS_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [autoPass, pass, frame, onAction]);

  // --- casting -------------------------------------------------------------------
  /**
   * The `fromZone` field of a cast action, written only when the cast does NOT
   * come from the hand (the engine's default, and omitting it is what every
   * hand cast has always done).
   *
   * ONE helper rather than a `=== 'graveyard'` test at each of the two build
   * sites, which is what both of them said: exile casts were legal online the
   * day §3.113 landed, and either site would have submitted one with no zone —
   * so the server would have looked for the card in the HAND and cleanly
   * rejected a cast it had itself just offered. A zone added to `CastZone`
   * tomorrow rides along with no edit here.
   */
  const zoneField = (zone: CastZone | undefined): { fromZone?: CastZone } =>
    zone === undefined || zone === 'hand' ? {} : { fromZone: zone };

  const onCastClick = (choice: CastChoice): void => {
    if (choice.canCastUntargeted) {
      submit({
        kind: 'castSpell',
        player: masked.viewer,
        instanceId: choice.instanceId,
        targets: [],
        ...zoneField(choice.fromZone),
        ...(choice.phyrexianLife === undefined ? {} : { phyrexianLife: choice.phyrexianLife }),
      });
    } else if (choice.targetSets.length > 0) {
      setPendingCast(choice);
    }
  };

  const commitCast = (targets: ReadonlyArray<InstanceId | PlayerId>): void => {
    if (!pendingCast) return;
    const cast: GameAction = {
      kind: 'castSpell',
      player: masked.viewer,
      instanceId: pendingCast.instanceId,
      targets,
      // The zone rides the choice — see `zoneField`.
      ...zoneField(pendingCast.fromZone),
      // So does the READING (§3.143): the server offers one cast per fundable
      // Phyrexian life amount, and dropping the field asks for one it may never
      // have offered.
      ...(pendingCast.phyrexianLife === undefined ? {} : { phyrexianLife: pendingCast.phyrexianLife }),
    };
    submitSequence([...pendingTaps, cast]);
  };

  /**
   * Cast a card the server hasn't offered yet, tapping for it first. Targets are
   * derived client-side (the server only enumerates them for casts it is already
   * offering) and the server re-validates the chosen one on arrival. Serves both
   * zones: a graveyard cast plans against the FLASHBACK cost and carries the zone.
   */
  const onTapCastClick = (card: CardInstance, fromZone: CastZone = 'hand'): void => {
    const sequence = castSequence(masked, masked.viewer, card, [], legalActions, fromZone);
    if (!sequence) return;
    const requirement = targetRequirement(card.def);
    if (requirement.count === 0) {
      submitSequence(sequence);
      return;
    }
    const options = legalTargets(requirement, masked, names);
    if (options.length === 0) return; // no legal target → the cast would fizzle
    // Hold the taps, then reuse the existing target picker for the choice.
    // `commitCast` REBUILDS the cast action once targets are known, so anything
    // the planner decided about it has to survive the round trip through
    // `pendingCast` — the READING its taps were planned for above all (§3.143),
    // since taps for "{1} and 4 life" followed by a 0-life cast is a sequence
    // the server stops halfway through.
    const planned = sequence[sequence.length - 1];
    const phyrexianLife =
      planned !== undefined && planned.kind === 'castSpell' ? planned.phyrexianLife : undefined;
    setPendingTaps(sequence.slice(0, -1));
    setPendingCast({
      instanceId: card.instanceId,
      targetSets: options.map((o) => [optionToTarget(o)]),
      canCastUntargeted: false,
      fromZone,
      ...(phyrexianLife === undefined ? {} : { phyrexianLife }),
    });
  };

  /**
   * The ONE thing a playable card does — play the land, cast the offered spell, or
   * start a tap-funded cast — for a card in EITHER castable zone. Click, drag and
   * the graveyard panel all route here, so no gesture can diverge from what
   * clicking the same card would have done. Re-checks the frame's affordances on
   * entry: a card that stopped being actionable mid-gesture (a new frame arrived)
   * simply does nothing.
   */
  const activateCard = (id: InstanceId, zone: CastZone = 'hand'): void => {
    if (!yourTurn) return;
    if (zone === 'graveyard') {
      const offered = graveyardCasts.get(id);
      if (offered) {
        onCastClick(offered);
        return;
      }
      if (graveyardTapCastable.has(id)) {
        const card = graveyardCardOf(id);
        if (card) onTapCastClick(card, 'graveyard');
      }
      return;
    }
    if (zone === 'exile') {
      // The server's offer or nothing — see `exileCasts` for why there is no
      // tap-to-fund fallback here.
      const offered = exileCasts.get(id);
      if (offered) onCastClick(offered);
      return;
    }
    if (lands.has(id)) {
      submit({ kind: 'playLand', player: masked.viewer, instanceId: id });
      return;
    }
    const cast = casts.get(id);
    if (cast) {
      onCastClick(cast);
      return;
    }
    if (tapCastable.has(id)) {
      const card = handCardOf(id);
      if (card) onTapCastClick(card, 'hand');
    }
  };

  /** The hand's chokepoint (drag + click), named for the drag hook. */
  const activateHandCard = (id: InstanceId): void => activateCard(id, 'hand');

  // Drag a hand card onto your battlefield — the gesture the original bug report
  // reached for first. Same action as clicking; see useDragToPlay for the model.
  const { drag, dropRef, handProps: dragHandProps } = useDragToPlay(activateHandCard);

  // --- the graveyard panel ---------------------------------------------------------
  /**
   * Every graveyard card as the panel renders it. The judging lives in the shared
   * pure `zonePanelView` — the hotseat board calls the same function with the same
   * zone row, so the two graveyards cannot drift.
   */
  const graveyardSeat =
    graveyardOpen === null ? null : graveyardOpen === view.self.id ? view.self : view.opponent;
  const graveyardPanelCards = useMemo(
    () =>
      graveyardSeat === null
        ? null
        : zonePanelView(
            'graveyard',
            {
              cards:
                graveyardSeat.id === masked.viewer
                  ? ownGraveyard.map((c) => ({
                      instanceId: c.instanceId,
                      cardId: c.def.id,
                      name: c.def.name,
                      castableEver: c.def.flashback !== undefined,
                    }))
                  : // The opponent's graveyard: a public zone, read as the adapted
                    // view carries it (bug report 20260907_190210); a reading
                    // surface, never a cast one, so nothing is castable from here.
                    graveyardSeat.graveyard.map((c) => ({
                      instanceId: c.instanceId,
                      cardId: c.cardId,
                      name: c.name,
                      castableEver: false,
                    })),
              // CR 404.2 — a graveyard hides nothing from anybody.
              hiddenCount: 0,
            },
            graveyardSeat.id === masked.viewer
              ? new Set([...graveyardCasts.keys(), ...graveyardTapCastable])
              : new Set(),
            {
              yours: graveyardSeat.id === masked.viewer,
              yourTurn,
              waitingOn: names[masked.priorityPlayer],
              step,
            },
          ),
    [graveyardSeat, masked.viewer, ownGraveyard, graveyardCasts, graveyardTapCastable, yourTurn, names, masked.priorityPlayer, step],
  );

  // --- the exile panel -------------------------------------------------------------
  /**
   * The opened exile, for whichever seat's chip was clicked.
   *
   * ⚠️ Built from `view` — the ADAPTED, already-masked board view — so a
   * face-down (foretold) card of the opponent's is not in `seat.exile` at all
   * and only its COUNT arrives. The server masked it (`maskStateForSeat`), the
   * adapter carried the two halves through, and this panel cannot render an
   * identity nobody handed it.
   */
  const exileSeat = exileOpen === null ? null : exileOpen === view.self.id ? view.self : view.opponent;
  const exilePanelView = useMemo(
    () =>
      exileSeat === null
        ? null
        : zonePanelView(
            'exile',
            {
              cards: exileSeat.exile.map((c) => ({
                instanceId: c.instanceId,
                cardId: c.cardId,
                name: c.name,
                // Only the server knows whether a permission stands — see the
                // `exile` row of ZONE_PANELS.
                castableEver: null,
              })),
              hiddenCount: exileSeat.exileHiddenCount,
            },
            // Only the viewer's own exile offers casts; the opponent's is a
            // reading surface, so every card there is inspectable but inert.
            exileSeat.id === masked.viewer ? new Set(exileCasts.keys()) : new Set<InstanceId>(),
            {
              yours: exileSeat.id === masked.viewer,
              yourTurn,
              waitingOn: names[masked.priorityPlayer],
              step,
            },
          ),
    [exileSeat, exileCasts, masked.viewer, yourTurn, names, masked.priorityPlayer, step],
  );

  // --- activated abilities (a planeswalker's loyalty lines) -------------------------
  /** Definitions come from the PUBLIC battlefield the server already sent. */
  const defOf = (id: InstanceId): CardDefinition | undefined =>
    masked.battlefield.find((c) => c.instanceId === id)?.def;
  const nameOfTarget = (target: InstanceId | PlayerId): string =>
    target === 'A' || target === 'B' ? `${names[target]} (player)` : nameOfInstance(target);

  /**
   * The activatable abilities, grouped per source permanent — derived from the
   * server's offers ALONE, exactly like the hotseat's `abilityOptions()`. An
   * ability the engine did not offer (used this turn, unpayable minus, wrong
   * timing) is simply absent, so the menu can hold no dead buttons.
   */
  const abilityMenu = useMemo(() => {
    const map = new Map<InstanceId, AbilityOption[]>();
    for (const opt of abilityChoices(legalActions, defOf, nameOfTarget)) {
      const list = map.get(opt.instanceId);
      if (list) list.push(opt);
      else map.set(opt.instanceId, [opt]);
    }
    return map;
    // `defOf`/`nameOfTarget` read the same frame the actions arrived on, so the
    // frame's identity below is the whole dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legalActions, masked, names, view]);

  const onChooseAbility = (opt: AbilityOption): void => {
    setAbilitySource(null);
    if (opt.targets === null) {
      submit({
        kind: 'activateAbility',
        player: masked.viewer,
        instanceId: opt.instanceId,
        abilityIndex: opt.abilityIndex,
      });
    } else {
      setPendingAbility(opt);
    }
  };

  // --- mana ------------------------------------------------------------------------
  const onTapForMana = (id: InstanceId): void => {
    const options = tapMenu.get(id);
    if (!options || options.length === 0) return;
    // One mode is not a decision; more than one is, so ask rather than pick.
    if (isModalTap(options)) {
      setPendingManaTap(options);
      return;
    }
    const only = options[0] as ManaTapOption;
    submit({ kind: 'tapForMana', player: masked.viewer, instanceId: only.instanceId, mode: only.mode });
  };

  // --- combat: attacker / blocker selection from the server templates -----------
  const eligibleAttackers = useMemo(
    () => new Set<InstanceId>(attackTemplate ? attackTemplate.attackers : []),
    [attackTemplate],
  );
  const attackerIds = masked.combat?.attackers ?? [];
  const inBlockStep = !!blockTemplate;
  /**
   * ⚠️ READ FROM THE BOARD, NOT FROM THE SERVER'S TEMPLATE — and that is a FIX,
   * not a shortcut. `blockTemplate.blocks` is core's *baseline* no-block
   * declaration (`generateLegalActions`: "offer the empty (no-block)
   * declaration as a baseline; the AI constructs specific assignments"), so it
   * is ALWAYS empty. Deriving candidates from it made this set always empty too,
   * and an online player could never declare a block at all — the only button a
   * defending seat ever saw was "No blocks". `eligibleBlockerIds` is the rule the
   * hotseat board has always used, now shared by both (rule 12).
   */
  const eligibleBlockers = useMemo(
    () => (blockTemplate ? eligibleBlockerIds(view) : NO_ELIGIBLE_BLOCKERS),
    [blockTemplate, view],
  );

  const toggleAttacker = (id: InstanceId): void => {
    const deselecting = chosenAttackers.has(id);
    setChosenAttackers((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // A deselected attacker attacks nothing — drop its walker assignment too.
    if (deselecting) {
      setWalkerAssign((assign) => {
        if (!assign.has(id)) return assign;
        const cleaned = new Map(assign);
        cleaned.delete(id);
        return cleaned;
      });
    }
  };

  /**
   * Defending planeswalkers that can be attacked instead of the player. Read off
   * the PUBLIC battlefield in the masked view — loyalty and walker-ness are public
   * (the protocol redacts neither), so the online client needs nothing extra.
   */
  const enemyWalkers = useMemo(
    () =>
      yourTurn && step === 'declareAttackers' && attackTemplate
        ? masked.battlefield.filter((c) => c.controller !== masked.viewer && isPlaneswalker(c.def))
        : [],
    [yourTurn, step, attackTemplate, masked],
  );

  /**
   * Clicking a defending walker routes the CURRENTLY selected attackers at it;
   * clicking it again (when they all already attack it) sends them back at the
   * player — identical semantics to the hotseat board, so a player who learned one
   * has learned the other.
   */
  const onAssignAttackWalker = (walkerId: InstanceId): void => {
    if (chosenAttackers.size === 0) {
      flash('Select attackers first, then click the planeswalker to attack it.');
      return;
    }
    setWalkerAssign((cur) => {
      const next = new Map(cur);
      const allAtWalker = [...chosenAttackers].every((a) => next.get(a) === walkerId);
      for (const a of chosenAttackers) {
        if (allAtWalker) next.delete(a);
        else next.set(a, walkerId);
      }
      return next;
    });
  };

  const onBlockBoardClick = (id: InstanceId): void => {
    if (attackerIds.includes(id)) {
      setActiveBlockTarget((cur) => (cur === id ? null : id));
      return;
    }
    if (eligibleBlockers.has(id) && activeBlockTarget !== null) {
      setBlockAssign((cur) => {
        const next = new Map(cur);
        if (next.get(id) === activeBlockTarget) next.delete(id);
        else next.set(id, activeBlockTarget);
        return next;
      });
    }
  };

  // --- per-seat interactions -----------------------------------------------------
  const selfInteraction: PermInteraction | undefined = (() => {
    if (yourTurn && step === 'declareAttackers' && attackTemplate) {
      // An attacker aimed at a walker says so on its marker; the rest read "ATK".
      const markers = new Map<InstanceId, string>();
      for (const id of chosenAttackers) {
        const walker = walkerAssign.get(id);
        markers.set(id, walker !== undefined ? `ATK → ${nameOfInstance(walker)}` : 'ATK');
      }
      return { selectableIds: eligibleAttackers, selectedIds: chosenAttackers, markers, onClick: toggleAttacker };
    }
    if (yourTurn && inBlockStep) {
      const markers = new Map<InstanceId, string>();
      for (const [blocker, atk] of blockAssign) markers.set(blocker, `→ ${nameOfInstance(atk)}`);
      return {
        selectableIds: eligibleBlockers,
        selectedIds: new Set(blockAssign.keys()),
        markers,
        onClick: onBlockBoardClick,
      };
    }
    // Outside a combat declaration, clicking your own untapped source taps it (the
    // marker shows what it makes), and a permanent with a server-offered activated
    // ability — a walker's loyalty lines — opens its ability menu. Mana-tapping
    // wins an overlap: it is the frequent action, and no pool permanent is both
    // today. Same chain, same precedence as the hotseat board.
    const activatable = new Set(abilityMenu.keys());
    if (yourTurn && (tappable.size > 0 || activatable.size > 0)) {
      const markers = new Map<InstanceId, string>();
      for (const id of activatable) markers.set(id, 'activate');
      for (const [id, options] of tapMenu) {
        if (tappable.has(id)) markers.set(id, isModalTap(options) ? 'any' : (options[0]?.label ?? ''));
      }
      return {
        selectableIds: new Set([...activatable, ...tappable]),
        selectedIds: new Set(),
        markers,
        onClick: (id) => {
          if (tappable.has(id)) onTapForMana(id);
          else setAbilitySource(id);
        },
      };
    }
    return undefined;
  })();

  const opponentInteraction: PermInteraction | undefined = (() => {
    // Declaring attackers with defending walkers on the board: the walkers are
    // clickable attack targets (see onAssignAttackWalker for the toggle semantics).
    if (yourTurn && step === 'declareAttackers' && enemyWalkers.length > 0) {
      const markers = new Map<InstanceId, string>();
      const selected = new Set<InstanceId>();
      for (const walker of enemyWalkers) {
        const incoming = [...chosenAttackers].filter((a) => walkerAssign.get(a) === walker.instanceId).length;
        if (incoming > 0) {
          markers.set(walker.instanceId, `⚔ ${incoming}`);
          selected.add(walker.instanceId);
        }
      }
      return {
        selectableIds: new Set(enemyWalkers.map((w) => w.instanceId)),
        selectedIds: selected,
        markers,
        onClick: onAssignAttackWalker,
      };
    }
    if (yourTurn && inBlockStep) {
      const markers = new Map<InstanceId, string>();
      if (activeBlockTarget !== null) markers.set(activeBlockTarget, 'blocking…');
      return {
        selectableIds: new Set(attackerIds),
        selectedIds: activeBlockTarget !== null ? new Set([activeBlockTarget]) : new Set(),
        markers,
        onClick: onBlockBoardClick,
      };
    }
    return undefined;
  })();

  const statusText = `Turn ${view.turnNumber} · ${stepLabel(step)} · ${names[view.activePlayer]}'s turn`;
  const inAttackStep = yourTurn && step === 'declareAttackers' && !!attackTemplate;

  // Context a greyed hand card explains itself against. `anyLandOffered` is the
  // server's own answer to "may a land be played this window", which is what
  // separates "wrong step" from "already played one".
  const disabledContext = useMemo(
    () => ({
      yourTurn,
      yourTurnToAct: masked.activePlayer === masked.viewer,
      step,
      waitingOn: names[masked.priorityPlayer],
      anyLandOffered: lands.size > 0,
    }),
    [yourTurn, masked, step, names, lands],
  );

  // --- §3.57 clarity systems -------------------------------------------------------
  /** The board container: the combat-lines canvas measures inside it. */
  const boardRootRef = useRef<HTMLDivElement>(null);

  /**
   * Where each tile last stood — the SHARED hook, so the damage blooms on this
   * board are placed by the same walk that places the hotseat board's.
   */
  const tileRectOf = useTileRects(boardRootRef);

  /** Jailed cards tucked under their jailer — the exile zones are PUBLIC. */
  const jails = useMemo(
    () =>
      groupJailedByJailer(
        jailSourcesOf([...masked.players.A.exile, ...masked.players.B.exile]),
        new Set(masked.battlefield.map((perm) => perm.instanceId)),
      ),
    [masked],
  );

  /**
   * Owner/zone lookup over the PUBLIC halves of the masked view plus the
   * viewer's OWN hand — exactly the zones the server already sent this seat,
   * so no label can say more than the wire did.
   */
  const refIndex = useMemo(() => {
    const refs: KnownRef[] = [];
    for (const perm of masked.battlefield) {
      refs.push({ instanceId: perm.instanceId, name: perm.def.name, controller: perm.controller, zone: 'battlefield' });
    }
    for (const pid of PLAYER_IDS) {
      for (const dead of masked.players[pid].graveyard) {
        refs.push({ instanceId: dead.instanceId, name: dead.def.name, controller: pid, zone: 'graveyard' });
      }
      for (const exiled of masked.players[pid].exile) {
        refs.push({ instanceId: exiled.instanceId, name: exiled.def.name, controller: pid, zone: 'exile' });
      }
    }
    for (const obj of masked.stack) {
      if (obj.kind === 'spell') {
        refs.push({ instanceId: obj.instanceId, name: obj.card.def.name, controller: obj.controller, zone: 'stack' });
      }
    }
    for (const held of masked.players[masked.viewer].hand ?? []) {
      refs.push({ instanceId: held.instanceId, name: held.def.name, controller: masked.viewer, zone: 'hand' });
    }
    return makeRefIndex(refs, masked.viewer, names);
  }, [masked, names]);

  /**
   * §3.143 wave 3 / UX-8 — how the SHARED prompts turn a server ref into a
   * drawable card on this board.
   *
   * `cardIdOf` widens `faceOfInstance` to the ref shape the prompts speak: a
   * PlayerId is a seat, which has no card, and `null` is the honest answer the
   * prompt draws a named plate for.
   *
   * There is deliberately NO `explanationOf`. `explainCharacteristics` needs the
   * full `GameState` and the continuous-effect index, and an online client holds
   * a masked view by design — so the faces here carry printed truth and say WHY
   * there is no attribution instead of drawing an empty breakdown, which would
   * read as "nothing is modifying this". Same limit `board-adapter.ts`'s `NO_MOD`
   * note states once already.
   */
  const promptFaces: AbilityPromptFaces = useMemo(
    () => ({
      cardIdOf: (ref: InstanceId | PlayerId) => (typeof ref === 'number' ? faceOfInstance(ref) : null),
      provenanceUnavailable: PROVENANCE_UNAVAILABLE_ONLINE,
    }),
    [faceOfInstance],
  );

  /**
   * §3.143 / UX-12 + UX-14 — the selections the player is still CLICKING. Handed
   * to the scene, which decides what a draft MEANS (a dashed arc, never an
   * advance); this only says what has been ticked.
   */
  const combatDraft: CombatDraft = {
    attackers: chosenAttackers,
    attackTargets: walkerAssign,
    blocks: blockAssign,
  };

  /**
   * §3.143 / UX-15 — the same pair the hotseat board builds, out of the same two
   * ingredients: the cumulative event stream and the last-known tile rects.
   *
   * `frame.events` is the PUBLIC half of the engine's log, filtered for THIS seat
   * by `maskEventsForSeat` server-side and accumulated across frames by
   * `onlineReducer`. There is deliberately no second derivation here — the board
   * does not diff frames to guess what hit what (rule 12); it is either told or
   * it animates nothing.
   */
  const damageSource: DamageSource = { events: frame.events, tileRectOf };

  /**
   * The tabletop's own numbers, from the scene that reads them — spread on
   * `.play-board` because `board-fit.css` declares
   * `--play-board-right-overlay-inset` on this element out of
   * `--play-log-rail-w`, and a custom property set on a descendant cannot feed
   * an ancestor's declaration.
   */
  const sceneVars = useBoardSceneVars();

  /** Is there ANY move available — a card, a mana source, or a combat declaration? */
  const hasAnyPlay =
    lands.size > 0 ||
    casts.size > 0 ||
    tapCastable.size > 0 ||
    graveyardCasts.size > 0 ||
    graveyardTapCastable.size > 0 ||
    tappable.size > 0 ||
    abilityMenu.size > 0 ||
    inAttackStep ||
    inBlockStep;
  const idleNote = idleTurnNote({ yourTurn, hasAnyPlay, step });
  /** Flashbacks available while the panel is shut — otherwise the affordance hides. */
  const flashbackCount = graveyardCasts.size + graveyardTapCastable.size;

  return (
    <div className="play-board" ref={boardRootRef} style={sceneVars}>
      <div className="play-board__status">
        <span className="play-board__turn">{statusText}</span>
        <span className="play-board__priority">
          {yourTurn ? 'Your move' : `Waiting for ${names[view.priorityPlayer]}…`}
        </span>
        <button type="button" className="btn btn--danger btn--ghost play-board__concede" onClick={onConcede}>
          Concede
        </button>
      </div>

      <BoardScene
        view={view}
        viewer={masked.viewer}
        boardRootRef={boardRootRef}
        selfInteraction={selfInteraction}
        opponentInteraction={opponentInteraction}
        jails={jails}
        onInspectCard={setZoomed}
        /* This client holds a MASKED view and cannot know what is modifying a
           permanent, and `CardFace` draws an empty breakdown as "nothing is" —
           a different and false claim. So the absence is named, not rendered as
           a zero. */
        provenanceUnavailableReason={PROVENANCE_UNAVAILABLE_ONLINE}
        onGraveyardClick={(seat) => setGraveyardOpen((open) => (open === seat ? null : seat))}
        onExileClick={(seat) => setExileOpen((open) => (open === seat ? null : seat))}
        drag={drag}
        dropRef={dropRef}
        combatDraft={combatDraft}
        measureKey={frame}
        damage={damageSource}
        rail={<ServerLog lines={log} />}
        selfZonePanels={
          <>
            {/* The opened graveyard. Flashback casts arrive in `legalActions` but the
                hand was the only clickable zone, so they were unreachable online —
                this is that affordance, routed through the same `activateCard`. */}
            {graveyardSeat !== null && graveyardPanelCards !== null && (
              <ZonePanel
                zone="graveyard"
                ownerName={graveyardSeat.name}
                view={graveyardPanelCards}
                onActivate={(id) => activateCard(id, 'graveyard')}
                onClose={() => setGraveyardOpen(null)}
              />
            )}
            {/* The opened EXILE — the same panel, the same funnel, mounted on BOTH
                boards because the graveyard's was and a surface that reaches only
                one of the two is the drift §3.143 GAP-20 was written about. */}
            {exileSeat !== null && exilePanelView !== null && (
              <ZonePanel
                zone="exile"
                ownerName={exileSeat.name}
                view={exilePanelView}
                onActivate={(id) => activateCard(id, 'exile')}
                onClose={() => setExileOpen(null)}
              />
            )}
          </>
        }
      />

      {/*
        §3.143 / UX-1 + UX-2 — the stack shows real card faces and FLOATS over the
        board instead of sharing a column with the log, exactly as on the hotseat
        board. `placement="floating"` is absolute against `.play-board`
        (styles.css gives it `position: relative`), and it is mounted OUTSIDE the
        scene: an absolutely-positioned descendant of a transformed box is
        positioned against that box and tilted with it.
      */}
      <StackPanel
        stack={stackFacts}
        names={names}
        nameOf={nameOfInstance}
        faceOf={faceOfInstance}
        viewer={masked.viewer}
        placement="floating"
      />

      {/*
        YOUR HAND IS OUTSIDE THE SCENE (UX-9). A tilted hand is unreadable, and
        under `transform-style: flat` — which is all this board can have, see
        board-scene.css — there is no counter-rotation that undoes the parent's
        projection. It used to sit INSIDE the viewer's seat region here, which is
        the one place the tilt would have made it illegible.
      */}
        <div
          className="play-hand"
          aria-label={`${view.self.name} hand`}
          data-anim-anchor={`hand:${view.self.id}`}
          {...dragHandProps}
          onDragStart={(e) => e.preventDefault()}
        >
          {(view.self.hand ?? []).map((c) => {
            const isLand = lands.has(c.instanceId);
            const cast = casts.get(c.instanceId);
            // A card the server hasn't offered but we can fund by tapping.
            const tapCard = !cast && tapCastable.has(c.instanceId) ? handCardOf(c.instanceId) : undefined;
            const actionable = yourTurn && (isLand || !!cast || !!tapCard);
            const dragging = drag?.id === c.instanceId ? drag : null;
            return (
              // The wrapper is the drag handle: `data-drag-id` marks it draggable
              // for the delegated pointer handlers, `touch-action: none` keeps
              // mobile browsers from turning the drag into a page scroll, and the
              // transform is the ghost following the pointer.
              <div
                key={c.instanceId}
                className={`hand-card-slot${dragging ? ' hand-card-slot--dragging' : ''}`}
                {...(actionable ? { [DRAG_ID_ATTR]: c.instanceId } : {})}
                style={
                  dragging
                    ? { touchAction: 'none', transform: `translate(${dragging.dx}px, ${dragging.dy}px)` }
                    : actionable
                      ? { touchAction: 'none' }
                      : undefined
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  setZoomed({ cardId: c.cardId, name: c.name });
                }}
              >
                {/*
                  §3.143 / UX-10 — HOVER YOUR OWN HAND. The hotseat hand got
                  this in §3.119 (report 20260901_205149, "I cant hover over my
                  own in hand cards to see what they are") and the online hand
                  was left on the old surface, so the SAME complaint was still
                  live in the SAME app depending on which mode you opened. Same
                  wrapper, same component, same funnel — a second hover
                  mechanism here would itself be the bug.
                */}
                <CardHover cardId={c.cardId}>
                  <PlayCard
                    cardId={c.cardId}
                    name={c.name}
                    face="full"
                    badge={c.isLand ? 'Land' : cast ? 'castable' : tapCard ? 'tap mana' : undefined}
                    disabled={!actionable}
                    reason={actionable ? undefined : reasonCardIsDisabled(disabledContext, c)}
                    onClick={actionable ? () => activateCard(c.instanceId, 'hand') : undefined}
                  />
                </CardHover>
                <button
                  type="button"
                  className="hand-card-slot__zoom"
                  aria-label={`Inspect ${c.name}`}
                  title={`Inspect ${c.name}`}
                  onClick={() => setZoomed({ cardId: c.cardId, name: c.name })}
                >
                  🔍
                </button>
              </div>
            );
          })}
          {(view.self.hand?.length ?? 0) === 0 && <span className="seat__empty">Empty hand</span>}
        </div>

      {zoomed && <CardZoomOverlay {...zoomed} onClose={() => setZoomed(null)} />}

      {/* Action bar. */}
      <div className="action-bar">
        {!yourTurn ? (
          <span className="action-bar__wait">
            {/* Names the asker and the card, never a candidate — the summary carries no more. */}
            {waitingText ?? `Waiting for ${names[view.priorityPlayer]}…`}
          </span>
        ) : (
          <>
            {inAttackStep && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  // `attackTargets` routes attackers at a defending walker; with no
                  // assignment the action is byte-identical to the pre-walker one.
                  submit(
                    buildDeclareAttackersAction(
                      masked.viewer,
                      [...chosenAttackers],
                      Object.fromEntries(walkerAssign),
                    ),
                  )
                }
              >
                {chosenAttackers.size > 0 ? `Attack with ${chosenAttackers.size}` : 'Attack with none'}
              </button>
            )}
            {inBlockStep && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  submit({
                    kind: 'declareBlockers',
                    player: masked.viewer,
                    blocks: [...blockAssign].map(([blocker, attacker]) => ({ blocker, attacker })),
                  })
                }
              >
                {blockAssign.size > 0
                  ? `Confirm ${blockAssign.size} block${blockAssign.size === 1 ? '' : 's'}`
                  : 'No blocks'}
              </button>
            )}
            {pass && (
              <button type="button" className="btn" onClick={() => submit(pass)}>
                Pass / advance
              </button>
            )}
            {/* A castable flashback is invisible while the graveyard is shut, and an
                affordance nobody can see is the same as not shipping it. */}
            {flashbackCount > 0 && graveyardOpen !== view.self.id && (
              <button type="button" className="btn btn--ghost" onClick={() => setGraveyardOpen(view.self.id)}>
                {`Flashback available (${flashbackCount})`}
              </button>
            )}
            <span className="action-bar__hint">
              {drag
                ? 'Drop the card on your battlefield to play it.'
                : ownChoice
                  ? 'Answer the question above to continue.'
                  : // A seat that holds priority with nothing to do is the state that
                    // read as a frozen app — say so plainly instead of giving the
                    // generic step hint next to a hand of dead cards. It reads the
                    // GATED decision, so a board holding on combat (§10) does not
                    // claim to be advancing while it is deliberately standing still.
                    autoPass
                    ? AUTO_ADVANCING_HINT
                    : (idleNote ??
                      actionBarHint(step, {
                        // The active player's own declare window, pre-declaration;
                        // once attackers are declared this seat is responding.
                        isAttackWindow:
                          masked.activePlayer === masked.viewer &&
                          masked.combat !== null &&
                          !masked.combat.attackersDeclared,
                        hasAttackers: (attackTemplate?.attackers.length ?? 0) > 0,
                        // The server offers a declareBlockers template only to
                        // the seat that may block, so its presence IS the window.
                        isBlockWindow: inBlockStep,
                        hasBlockers: eligibleBlockers.size > 0,
                        hasEnemyWalkers: enemyWalkers.length > 0,
                        mainPhaseFlavor: 'online',
                      }))}
            </span>
          </>
        )}
      </div>

      {/*
        The parked question, rendered by the SAME `ChoicePrompt` the hotseat uses —
        one choice UI, not two. It appears only for the seat the server addressed the
        choice to, which is also the only seat that was sent its candidates. Every
        kind routes here, including the CAST-TIME questions: an {'{X}'} cost arrives
        as `chooseNumber`, kicker as `payMana`, a shockland's as `payLife`, and the
        naming a permanent makes as it enters ("choose a creature type") as
        `chooseValue`.
      */}
      {ownChoice && (
        <ChoicePrompt
          choice={ownChoice}
          names={names}
          onAnswer={(answer) => submit(answerChoiceAction(masked.viewer, ownChoice, answer))}
          zoneOf={refIndex.zoneOf}
          /* UX-8 on THIS board too: `TargetOption` carries no card id, so
             without this every target row here was a named placeholder while
             the hotseat's were faces. Same public index the labels come from. */
          cardIdOf={promptFaces.cardIdOf}
        />
      )}

      {/* Which ability of this permanent? (a planeswalker's loyalty lines). Only
          server-offered abilities are listed, so a used-this-turn or unpayable line
          is simply absent rather than disabled. */}
      {abilitySource !== null && (
        <AbilityMenuPrompt
          source={{ instanceId: abilitySource, name: nameOfInstance(abilitySource) }}
          options={abilityMenu.get(abilitySource) ?? []}
          faces={promptFaces}
          onChoose={onChooseAbility}
          onCancel={() => setAbilitySource(null)}
        />
      )}

      {/* The chosen ability's targets — one button per server-offered legal target. */}
      {pendingAbility && pendingAbility.targets !== null && (
        <AbilityTargetPrompt
          ability={pendingAbility}
          faces={promptFaces}
          annotateTarget={refIndex.noteOf}
          onPick={(target) =>
            submit({
              kind: 'activateAbility',
              player: masked.viewer,
              instanceId: pendingAbility.instanceId,
              abilityIndex: pendingAbility.abilityIndex,
              targets: [target],
            })
          }
          onCancel={() => setPendingAbility(null)}
        />
      )}

      {/* Which colour should this modal source make? (Birds of Paradise, a dual land.) */}
      {pendingManaTap && (
        <div className="target-prompt" role="dialog" aria-label="Choose which mana to add">
          <div className="target-prompt__card">
            <div className="target-prompt__title">
              Add which mana from {nameOfInstance(pendingManaTap[0]?.instanceId ?? 0)}?
            </div>
            <div className="target-prompt__options">
              {pendingManaTap.map((opt) => (
                <button
                  key={opt.mode ?? 0}
                  type="button"
                  className="btn"
                  onClick={() =>
                    submit({
                      kind: 'tapForMana',
                      player: masked.viewer,
                      instanceId: opt.instanceId,
                      mode: opt.mode,
                    })
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => setPendingManaTap(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Target prompt: choose among the server's enumerated legal target sets.

          §3.143 / UX-8 — *"anytime a card is asking me to choose target(s), it
          should be showing the actual card(s) that is provoking the choice - not
          just the card name"*. The source renders as a real `CardFace` (so every
          ability word on it is hoverable and explained) and each single-card
          candidate goes through the hover funnel, matching `PlayBoard`'s prompt
          line for line. */}
      {pendingCast && (
        <div className="target-prompt" role="dialog" aria-label="Choose a target">
          <div className="target-prompt__card">
            <div className="target-prompt__title">
              Choose a target for {nameOfInstance(pendingCast.instanceId)}
            </div>
            <CardHover cardId={faceOfInstance(pendingCast.instanceId)}>
              <CardFace
                size="full"
                cardId={faceOfInstance(pendingCast.instanceId)}
                name={nameOfInstance(pendingCast.instanceId)}
              />
            </CardHover>
            <div className="target-prompt__options">
              {pendingCast.targetSets.length === 0 && (
                <span className="seat__empty">No legal targets — cancel.</span>
              )}
              {pendingCast.targetSets.map((set, i) => (
                <CardHover key={i} cardId={soleTargetFace(set, faceOfInstance)}>
                  <button type="button" className="btn" onClick={() => commitCast(set)}>
                    {/* Owner + zone ride every row (§3.57) — resolved through the
                        public-zone index, so a graveyard target names its yard. */}
                    {describeTargetSetWithOwners(set, refIndex)}
                  </button>
                </CardHover>
              ))}
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => setPendingCast(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="play-toast" role="status">
          {toast}
        </div>
      )}

      {/* THE SAME ONE ANNOUNCEMENT SURFACE the hotseat board mounts. This board
          produces only the §10 combat beat today — it has no spell hold, no
          settled-choice banner and no reveal, for the reason §12 states (it sees
          a masked STATE and, until recently, no events at all). It goes through
          the surface anyway, and that is the point: the next announcement added
          here cannot become a fifth hand-rolled `position: fixed` element,
          because `announcement-queue.test.ts` fails the moment a board mounts an
          announcement component outside this one seam. */}
      <AnnouncementSurface queue={announcements} renderers={announcementRenderers} />
    </div>
  );
}

/** How long a transient board message stays up (matches the hotseat board's feel). */
const TOAST_MS = 2600;

/** The running game log, rendered from the server's pre-formatted text lines. */
function ServerLog({ lines }: { lines: readonly string[] }): ReactElement {
  return (
    <div className="game-log" aria-label="Game log" aria-live="polite">
      <div className="game-log__title">Game Log</div>
      <div className="game-log__lines">
        {lines.length === 0 ? (
          <div className="game-log__empty">The game begins…</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="game-log__line">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The face to preview for one enumerated target SET, or `null` for none.
 *
 * A set naming exactly one permanent previews that permanent. A set naming
 * several, or a player, previews NOTHING — a row that reads "Grizzly Bears and
 * Llanowar Elves" cannot honestly magnify one of the two, and a preview that
 * silently picks the first would make the player aim at the card they were
 * shown. Refusing is the closed-table answer (rule 2): the row still carries
 * every name in text.
 *
 * (`nameOfPerm` used to live here — a second answer to "what is instance N
 * called" that only knew the battlefield, so an ability whose source had died
 * printed `#12`. Every caller now goes through the seat's one instance index.)
 */
function soleTargetFace(
  set: ReadonlyArray<InstanceId | PlayerId>,
  faceOf: (id: InstanceId) => string | null,
): string | null {
  if (set.length !== 1) return null;
  const only = set[0];
  if (only === undefined || isPlayerTarget(only)) return null;
  return faceOf(only);
}

// The per-step hint and the target-set labels both moved to shared, tested
// modules (`lib/play/action-hints.ts`, `lib/play/option-labels.ts`) so the two
// boards render identical copy from one rule (§3.57).
