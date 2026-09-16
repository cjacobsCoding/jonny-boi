/**
 * **Where an instance id can hide** — the one place this repo answers "does this
 * value name a card?", and the reason the answer cannot rot.
 *
 * ## The bug this file exists to make impossible
 * The hidden-information guarantee (`packages/sim/src/observation.ts`,
 * `@jonny-boi/protocol`'s `maskStateForSeat`) is proved by a scan that asks, of
 * every message the engine hands out, "which cards does this name?" — and then
 * checks none of them is sitting in a hand or a library.
 *
 * That scan used to answer the question by collecting the values of keys named
 * exactly `instanceId`. **Every other id-bearing field walked straight past it.**
 * The engine names cards under `sourceInstanceId`, `targetInstanceId`,
 * `keptInstanceId`, `copiedInstanceId`, `hostInstanceId`, `source`, `target`,
 * `targets`, `attackers`, `attackTargets`, `blocks`, `instanceIds`, `ref`,
 * `attachedTo` … — so the scan was blind to eighteen of the nineteen ways this
 * engine spells "that card". Two independent agents found real leaks through
 * that blind spot (a `choiceAsked.sourceInstanceId` pointing into the discarding
 * player's HAND — and instance ids are minted sequentially from the pre-shuffle
 * library, so publishing one is publishing a read on that decklist). Both times
 * the INSTANCE was fixed and the scan was not, which left the class open.
 *
 * ## Why a hand-maintained key list would not do
 * A list of key names is exactly the thing that goes stale the next time somebody
 * adds a field, and nothing would fail. So there are two mechanisms here, and
 * neither is a list somebody has to remember to update:
 *
 *  1. {@link EVENT_ID_FIELDS} is a **mapped type over every field of every
 *     `GameEvent`**. Adding a field to an event — or a whole new event — makes
 *     this file fail to compile until somebody says whether the new field can
 *     name a card. Same shape, and same reason, as `OBSERVATION_POLICY`,
 *     `SOAK_EVENT_WITNESS`, `KEYWORD_KEYS` and `CARD_TYPE_BIT`: a new thing must
 *     not default into the safe-looking bucket.
 *  2. {@link INSTANCE_ID_FIELD_NAMES} is **derived** from that table (plus the
 *     handful of id fields that live on state rather than on events), and
 *     `instance-ids.test.ts` re-derives it by reading core's own source: every
 *     property in `packages/core/src` whose declared type mentions `InstanceId`
 *     must appear here, and every name here must still be declared somewhere.
 *     A new id field in a state type therefore fails a test even though no
 *     event changed.
 *
 * The compiler stops what a compiler can stop; the source scan covers the rest.
 * Neither is a list anybody maintains by hand.
 */

import type { ChoiceAnswer } from './choices.js';
import type { GameEvent } from './events.js';
import type { InstanceId } from './state.js';

/**
 * How instance ids sit inside one field.
 *
 * Deliberately a small closed vocabulary rather than "walk it and hope": the
 * shapes below are the only ones the engine actually uses, and a NEW shape has
 * to be added here (and taught to {@link idsInField}) before it can be
 * classified — which is one more place a new way of naming a card has to pass
 * through in the open.
 */
export type InstanceIdShape =
  /** Carries no instance id at all, at any depth. */
  | 'none'
  /** One id — or an `InstanceId | PlayerId`, where the seat is not an id. */
  | 'id'
  /** An array of ids (possibly `InstanceId | PlayerId`). */
  | 'idList'
  /** `Record<InstanceId, InstanceId | PlayerId>` — the KEYS are ids too. */
  | 'idKeyedMap'
  /** An array of objects whose every numeric field is an id (`{blocker, attacker}`). */
  | 'idPairList'
  /** A {@link ChoiceAnswer} — classified field-by-field by {@link CHOICE_ANSWER_ID_FIELDS}. */
  | 'answer';

/** The one event member with this `type` tag. */
type EventOf<K extends GameEvent['type']> = Extract<GameEvent, { readonly type: K }>;

/**
 * Every field of one event, classified. A **mapped type**, so it is exhaustive by
 * construction in both directions: a field nobody classified is a compile error,
 * and so is an entry for a field that no longer exists. `-?` because an optional
 * field is exactly as capable of carrying an id as a required one.
 */
type EventIdFields<K extends GameEvent['type']> = {
  readonly [F in Exclude<keyof EventOf<K>, 'type'>]-?: InstanceIdShape;
};

/**
 * WHICH FIELDS OF WHICH EVENTS NAME A CARD. **Adding an event field breaks the
 * build until it is classified here.**
 *
 * `'none'` is a claim, not a default — it says "this field can never hold an
 * instance id", and the type cannot check that for you because `InstanceId` is a
 * `number` and so are life totals. What DOES check it is
 * `instance-ids.test.ts`'s source scan: it reads `events.ts` and fails if a
 * field whose declared type mentions `InstanceId` is classified `'none'` here.
 *
 * Ordered as `events.ts` declares them, so the two files read side by side.
 */
export const EVENT_ID_FIELDS: { readonly [K in GameEvent['type']]: EventIdFields<K> } = {
  gameStart: { seed: 'none', startingPlayer: 'none' },
  turnBegin: { turn: 'none', activePlayer: 'none' },
  stepBegin: { step: 'none', activePlayer: 'none' },
  priorityPassed: { player: 'none' },
  untapped: { instanceId: 'id', player: 'none' },
  drawCard: { player: 'none', instanceId: 'id' },
  zoneChange: { instanceId: 'id', from: 'none', to: 'none' },
  landPlayed: { player: 'none', instanceId: 'id' },
  spellCast: { player: 'none', instanceId: 'id', name: 'none', castTypes: 'none', fromZone: 'none' },
  cardCycled: { player: 'none', instanceId: 'id', name: 'none' },
  madnessWindowOpened: { player: 'none', instanceId: 'id', name: 'none' },
  // §3.106 suspend
  cardSuspended: { player: 'none', instanceId: 'id', name: 'none', timeCounters: 'none' },
  suspendWindowOpened: { player: 'none', instanceId: 'id', name: 'none' },
  suspendDeclined: { player: 'none', instanceId: 'id', name: 'none' },
  // §3.112 foretell / plot
  cardExiledToCastLater: { player: 'none', instanceId: 'id', method: 'none' },
  // §3.113 — cascade / ripple windows and the pile they bottom.
  cascadeWindowOpened: { player: 'none', instanceId: 'id', name: 'none' },
  rippleWindowOpened: { player: 'none', instanceId: 'id', name: 'none' },
  pileBottomed: { player: 'none', instanceIds: 'idList', random: 'none' },
  madnessDeclined: { player: 'none', instanceId: 'id', name: 'none' },
  stackResolved: { instanceId: 'id', name: 'none' },
  manaAdded: { player: 'none', color: 'none', amount: 'none', spendRestriction: 'none' },
  manaPoolEmptied: { player: 'none' },
  manaCostPaid: { player: 'none', cost: 'none' },
  controlChanged: { instanceId: 'id', from: 'none', to: 'none' },
  cardsMilled: { player: 'none', amount: 'none' },
  cardsLookedAt: { player: 'none', amount: 'none' },
  // fix/reports-2026-09-01 — the revealed card and the permanent whose ability revealed it.
  cardRevealed: {
    player: 'none',
    instanceId: 'id',
    name: 'none',
    fromZone: 'none',
    sourceInstanceId: 'id',
    matched: 'none',
  },
  abilityActivated: { player: 'none', instanceId: 'id', label: 'none' },
  tapped: { instanceId: 'id' },
  effectApplied: { primitive: 'none', sourceInstanceId: 'id' },
  effectUnsupported: { primitive: 'none', sourceInstanceId: 'id' },
  // `attackTargets` is keyed BY attacker id and valued by the attacked object —
  // both halves are ids, which is exactly the shape a key-name scan misses.
  attackersDeclared: { attackers: 'idList', attackTargets: 'idKeyedMap' },
  blockersDeclared: { blocks: 'idPairList' },
  damageDealt: { source: 'id', target: 'id', amount: 'none', combat: 'none', round: 'none' },
  damagePrevented: { source: 'id', target: 'id', amount: 'none', combat: 'none', round: 'none' },
  counterPrevented: { instanceId: 'id', name: 'none', controller: 'none' },
  replacementApplied: { source: 'id', event: 'none', from: 'none', to: 'none', prevented: 'none', label: 'none' },
  // `id` here is the FLOATING EFFECT's id, not a card's — a number that looks
  // exactly like an instance id and is not one. The reason the scan is driven by
  // this table rather than by "collect every number".
  replacementExpired: { id: 'none', source: 'id' },
  lifeChanged: { player: 'none', delta: 'none', to: 'none' },
  gainLife: { player: 'none', amount: 'none' },
  // poison family (§3.105) — `lifeChanged`'s shape: a player and two counts.
  poisonChanged: { player: 'none', delta: 'none', to: 'none' },
  creatureDied: { instanceId: 'id', name: 'none' },
  loyaltyChanged: { instanceId: 'id', delta: 'none', to: 'none' },
  planeswalkerDied: { instanceId: 'id', name: 'none' },
  defenseChanged: { instanceId: 'id', delta: 'none', to: 'none' },
  battleDefeated: { instanceId: 'id', name: 'none' },
  legendRuleApplied: { player: 'none', name: 'none', keptInstanceId: 'id' },
  emblemCreated: { instanceId: 'id', controller: 'none', name: 'none' },
  playerLost: { player: 'none', reason: 'none' },
  gameOver: { winner: 'none' },
  actionRejected: { reason: 'none' },
  counterAdded: { instanceId: 'id', kind: 'none', amount: 'none' },
  // §3.110 — the counter keyword family's two events.
  becameRenowned: { instanceId: 'id', name: 'none' },
  chosenAsEnters: { instanceId: 'id', name: 'none', subject: 'none', value: 'none', described: 'none' },
  regenerated: { instanceId: 'id', name: 'none' },
  triggerPutOnStack: { sourceInstanceId: 'id', controller: 'none', label: 'none' },
  triggerModesChosen: { sourceInstanceId: 'id', controller: 'none', label: 'none', modeIds: 'none', modeLabels: 'none' },
  triggerFizzled: { sourceInstanceId: 'id', controller: 'none', label: 'none', reason: 'none' },
  triggerTargetsChosen: { sourceInstanceId: 'id', controller: 'none', label: 'none', targets: 'idList' },
  modesChosen: { player: 'none', instanceId: 'id', name: 'none', modes: 'none' },
  modeTargetChosen: { player: 'none', instanceId: 'id', mode: 'none', targets: 'idList' },
  triggerRemovedFromStack: { sourceInstanceId: 'id', controller: 'none', label: 'none', reason: 'none' },
  triggeredAbilityResolved: { sourceInstanceId: 'id', label: 'none' },
  continuousEffectExpired: { targetInstanceId: 'id', sourceInstanceId: 'id', duration: 'none' },
  continuousEffectAdded: {
    targetInstanceId: 'id',
    sourceInstanceId: 'id',
    duration: 'none',
    power: 'none',
    toughness: 'none',
  },
  cardGrantAdded: { targetInstanceId: 'id', sourceInstanceId: 'id', duration: 'none' },
  cardGrantExpired: { targetInstanceId: 'id', sourceInstanceId: 'id' },
  permanentAttached: { instanceId: 'id', hostInstanceId: 'id' },
  permanentUnattached: { instanceId: 'id', hostInstanceId: 'id' },
  attachmentFailed: { instanceId: 'id', reason: 'none' },
  attachmentPutIntoGraveyard: { instanceId: 'id', name: 'none' },
  transformed: { instanceId: 'id', fromName: 'none', toName: 'none', faceUp: 'none' },
  becameCopy: { instanceId: 'id', ownName: 'none', copiedName: 'none', copiedInstanceId: 'id' },
  tokenCreated: { instanceId: 'id', controller: 'none', name: 'none' },
  tokenCeasedToExist: { instanceId: 'id', name: 'none', zone: 'none' },

  /*
   * THE COPY FAMILY (CR 707). Every id here names an object on the STACK or the
   * BATTLEFIELD, never a card in a hand or a library: a copy is created from a
   * spell the whole table watched be cast, and a token copy from a permanent in
   * play. That is why all three events are `'public'` in `OBSERVATION_POLICY`,
   * and this table is what makes that claim checkable rather than asserted.
   */
  spellCopied: { instanceId: 'id', copiedInstanceId: 'id', controller: 'none', name: 'none' },
  // Both ids are real object ids and must be remapped like a spell copy's. The
  // `label` is printed ability text, not an id — the same 'none' a name gets.
  triggerCopied: { instanceId: 'id', copiedInstanceId: 'id', controller: 'none', label: 'none' },
  spellCopyCeasedToExist: { instanceId: 'id', name: 'none' },
  tokenCopyCreated: { instanceId: 'id', copiedInstanceId: 'id', controller: 'none', name: 'none' },

  /*
   * DELAYED TRIGGERED ABILITIES (CR 603.7). `id` is the ABILITY's own id — a
   * number minted from the same counter that names no card, exactly like
   * `replacementExpired.id`, and precisely why this table is driven by declared
   * types rather than by "collect every number". `sourceInstanceId` IS a card,
   * and it is always the object whose effect created the ability: a permanent on
   * the battlefield or a spell resolving off the stack, both of which the whole
   * table watched. Never a card in a hand or a library — which is what makes
   * both events `'public'` in `OBSERVATION_POLICY`.
   */
  delayedTriggerCreated: { id: 'none', sourceInstanceId: 'id', controller: 'none', label: 'none' },
  delayedTriggerFired: { id: 'none', sourceInstanceId: 'id', controller: 'none', label: 'none' },
  // §3.154 — the expiry half. `id` is the record's own identity, not a card's,
  // exactly as it is on the fired event above.
  delayedTriggerExpired: { id: 'none', controller: 'none', label: 'none' },
  // `choiceId` is the QUESTION's id, not a card's. `sourceInstanceId` is a card's
  // — and is the field the CR 514.1 cleanup discard once pointed at a card in the
  // discarding player's hand (see `NO_ASKING_OBJECT` in `choices.ts`).
  choiceAsked: {
    choiceId: 'none',
    chooser: 'none',
    choiceKind: 'none',
    prompt: 'none',
    sourceInstanceId: 'id',
    optionCount: 'none',
  },
  choiceAnswered: { choiceId: 'none', chooser: 'none', choiceKind: 'none', answer: 'answer', summary: 'none' },
  choiceAutoAnswered: {
    choiceId: 'none',
    chooser: 'none',
    choiceKind: 'none',
    answer: 'answer',
    reason: 'none',
    // Same card, same classification as `choiceAsked` above — including the
    // cleanup discard's `NO_ASKING_OBJECT`, which every remapper already passes
    // through untouched because it matches no real instance.
    sourceInstanceId: 'id',
    sourceName: 'none',
  },
  choiceAbandoned: { sourceInstanceId: 'id', reason: 'none' },
};

/** The one answer member with this `kind` tag. */
type AnswerOf<K extends ChoiceAnswer['kind']> = Extract<ChoiceAnswer, { readonly kind: K }>;

type AnswerIdFields<K extends ChoiceAnswer['kind']> = {
  readonly [F in Exclude<keyof AnswerOf<K>, 'kind'>]-?: InstanceIdShape;
};

/**
 * The same table, one level down, for the payload of an answered choice.
 *
 * An answer is the most card-naming value in the engine ("put THIS one into your
 * hand"), so it gets the same treatment rather than a `typeof x === 'number'`
 * guess: adding a field to any `ChoiceAnswer` variant breaks the build here.
 */
export const CHOICE_ANSWER_ID_FIELDS: { readonly [K in ChoiceAnswer['kind']]: AnswerIdFields<K> } = {
  selectCards: { instanceIds: 'idList' },
  selectPlayers: { players: 'none' },
  chooseModes: { modeIds: 'none' },
  confirm: { yes: 'none' },
  payMana: { pay: 'none' },
  payLife: { pay: 'none' },
  chooseNumber: { value: 'none' },
  chooseValue: { value: 'none' },
  selectTargets: { targets: 'idList' },
};

/**
 * Key names that hold an instance id but appear only OUTSIDE the event union —
 * on `GameState`, on a `PendingChoice`, on a resolution frame.
 *
 * This is the one hand-written list in the file, and it is the one the source
 * scan in `instance-ids.test.ts` re-derives: a new id field on a state type
 * fails that test even though no event changed. Each entry says where it lives,
 * because "why is this here" is the question a reader will have.
 */
const NON_EVENT_INSTANCE_ID_FIELDS = [
  /**
   * \`CardInstance.exiledUntilLeavesBy\` — the O-Ring jail link (§3.56): the
   * permanent that exiled this card "until it leaves the battlefield".
   */
  'exiledUntilLeavesBy',
  /** \`CardInstance.attachedTo\` — the host an Aura/Equipment is attached to. */
  'attachedTo',
  /**
   * `PayManaRequest.stakeInstanceId` (§3.106) — the permanent an upkeep bill
   * sacrifices when declined. A choice field, never an event's: the chooser
   * owns the permanent, so nothing here can leak across the table.
   */
  'stakeInstanceId',
  /** `CombatState.blocks` values + `BlockAssignment.attacker` (block-solver). */
  'attacker',
  /** `CombatState.blocks` keys + `BlockAssignment.blocker`. */
  'blocker',
  /** `CombatState.removedFromCombat` — ids taken out of combat (CR 506.4). */
  'removedFromCombat',
  /**
   * `CostAssistPlan.consumed` — the creatures a convoked spell will tap, the
   * artifacts an improvised one will tap, the graveyard cards a delved one will
   * exile (§3.70). A PLAN, never game state: it is rebuilt from the live board
   * on the pay path and never stored, so nothing here can outlive the cast.
   */
  'consumed',
  /** `ChoiceCandidate.ref` — the object an option refers to. */
  'ref',
  /** `SelectCardsAnswer.instanceIds` — the cards an answer picked. */
  'instanceIds',
  /** `ResolutionFrame.effectTargets` — per-effect aims parked mid-resolution. */
  'effectTargets',
  /**
   * `PendingTrigger` / `TriggeredStackObject` / `ResolutionFrame` /
   * `EffectContext.triggeringInstances` — "that creature": the objects a combat
   * declaration was about, carried to the trigger's body (DESIGN §3.107).
   * Always creatures declared attacking or blocking, which the whole table
   * watched — never a card in a hand or a library.
   */
  'triggeringInstances',
  /**
   * `TriggerAbout.instances` (§3.110) — the SAME objects `triggeringInstances`
   * carries, handed to `interveningIfHolds` so evolve's "if that creature has
   * greater power or toughness" can compare them. A second name for one fact
   * rather than a second fact: the record is built at the two CR 603.4 check
   * sites from the pending trigger's own `triggeringInstances`, never from a
   * hidden zone, and it is read-only.
   */
  'instances',
  /** `ModeChoice.appliesToInstanceId` — which object a chosen mode applies to. */
  'appliesToInstanceId',
  /** `ReplacementQuery.recipientIs` — the object a replacement is asked about. */
  'recipientIs',
  /**
   * `DelayedTriggeredAbility.removesFromBattlefield` — the permanents a pending
   * delayed ability (CR 603.7) will remove. Always tokens the whole table
   * watched be created, but the scan is driven by the DECLARED TYPE, not by what
   * the values happen to be today.
   */
  'removesFromBattlefield',
  /**
   * `TapForManaAction.costInstanceId` — the permanent paying a mana ability's
   * additional cost ("tap an untapped creature you control", "sacrifice a
   * Food"). Part of the ACTION because a mana ability may not park a question
   * (CR 605.3a), so it is an id the scanner must know about.
   */
  'costInstanceId',
  /**
   * `ActivateAbilityAction.costInstanceIds` — the permanents paying a
   * "Sacrifice a <noun>" activation cost. Named by the action because the cost
   * is paid at activation (CR 602.2b), before the ability is on the stack.
   */
  'costInstanceIds',
  /**
   * `MadnessWindow.pile` (§3.113) — the cards a cascade or ripple window took
   * off the top of the library and will bottom when it closes. They sit
   * face-up in exile while the window stands, so the ids are public; the
   * scanner must still know the key holds them.
   */
  'pile',
  /** `GameState.nextInstanceId` — the id source. Not a card, but it IS an id. */
  'nextInstanceId',
] as const;

/**
 * **Every key name in this engine that can hold an instance id**, at any depth.
 *
 * Derived, not written: the event/answer halves come straight out of the tables
 * above, so classifying a new field as anything but `'none'` extends this set for
 * free — the structural scanner in `@jonny-boi/protocol` starts seeing it the
 * moment somebody says it is an id.
 *
 * `'answer'` fields are the one shape excluded, and not as an exception: an
 * answer is a tagged CONTAINER whose own ids are named by
 * {@link CHOICE_ANSWER_ID_FIELDS} (`instanceIds`, `targets` — both already here).
 * A structural walker descends into it either way; the key `answer` itself never
 * holds a number.
 */
const idFieldNamesOf = (table: Record<string, Record<string, InstanceIdShape>>): string[] =>
  Object.values(table).flatMap((fields) =>
    Object.entries(fields)
      .filter(([, shape]) => shape !== 'none' && shape !== 'answer')
      .map(([name]) => name),
  );

export const INSTANCE_ID_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  ...NON_EVENT_INSTANCE_ID_FIELDS,
  ...idFieldNamesOf(EVENT_ID_FIELDS as unknown as Record<string, Record<string, InstanceIdShape>>),
  ...idFieldNamesOf(CHOICE_ANSWER_ID_FIELDS as unknown as Record<string, Record<string, InstanceIdShape>>),
]);

/** Add `value` if it is an id (a `PlayerId` in an `InstanceId | PlayerId` is not). */
function addIfId(value: unknown, into: Set<InstanceId>): void {
  if (typeof value === 'number' && Number.isFinite(value)) into.add(value);
}

/** Pull the ids out of one field, given the shape somebody classified it as. */
function idsInField(shape: InstanceIdShape, value: unknown, into: Set<InstanceId>): void {
  if (value === undefined || value === null) return;
  switch (shape) {
    case 'none':
      return;
    case 'id':
      addIfId(value, into);
      return;
    case 'idList':
      if (Array.isArray(value)) for (const item of value) addIfId(item, into);
      return;
    case 'idKeyedMap':
      // Both halves: the KEY is the attacker, the value is what it attacked.
      // A scan that read only the values would publish half of a leak.
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        addIfId(Number(key), into);
        addIfId(item, into);
      }
      return;
    case 'idPairList':
      if (Array.isArray(value)) {
        for (const pair of value) {
          if (pair === null || typeof pair !== 'object') continue;
          for (const item of Object.values(pair as Record<string, unknown>)) addIfId(item, into);
        }
      }
      return;
    case 'answer':
      idsInAnswer(value, into);
      return;
    default:
      // An unreachable default rather than a silent skip: a new shape that was
      // added to the vocabulary but never taught to this switch must be LOUD.
      throw new Error(`unclassified instance-id shape: ${String(shape)}`);
  }
}

function idsInAnswer(value: unknown, into: Set<InstanceId>): void {
  if (value === null || typeof value !== 'object') return;
  const kind = (value as { readonly kind?: string }).kind;
  const fields = kind === undefined ? undefined : CHOICE_ANSWER_ID_FIELDS[kind as ChoiceAnswer['kind']];
  if (!fields) throw new Error(`answer of unclassified kind: ${String(kind)}`);
  for (const [name, shape] of Object.entries(fields as Record<string, InstanceIdShape>)) {
    idsInField(shape, (value as Record<string, unknown>)[name], into);
  }
}

/**
 * **Every card an event (or a projection of one) names.** Exact, and driven off
 * the type definitions rather than off key names — this is what makes the
 * hidden-information scan see `sourceInstanceId`, `attackTargets`' keys and an
 * answer's `instanceIds` as readily as it sees `instanceId`.
 *
 * Accepts an `Observation` as readily as a `GameEvent`: a redacted observation
 * only ever DROPS fields from its event, so the event's classification still
 * describes it exactly. A field that is absent contributes nothing.
 *
 * **Throws on an event type it does not know.** A scan that quietly returned an
 * empty set for an unclassified type would be a green test that checked nothing,
 * which is the exact failure this whole file exists to prevent.
 */
export function instanceIdsNamedBy(value: { readonly type: string }): Set<InstanceId> {
  const found = new Set<InstanceId>();
  const fields = EVENT_ID_FIELDS[value.type as GameEvent['type']] as
    | Record<string, InstanceIdShape>
    | undefined;
  if (!fields) throw new Error(`event of unclassified type: ${String(value.type)}`);
  for (const [name, shape] of Object.entries(fields)) {
    idsInField(shape, (value as unknown as Record<string, unknown>)[name], found);
  }
  return found;
}
