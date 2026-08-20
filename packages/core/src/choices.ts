/**
 * Player CHOICES — the seam that lets a resolving spell/ability ask a player a
 * question ("discard a nonland card", "choose two modes", "you may shuffle").
 *
 * ## Why it is DATA and not a callback
 * The obvious implementation — hand the effect a `ask(): Promise<Answer>` — would
 * break every contract the rest of the project is built on: `GameState` must stay
 * plain, cloneable, serializable data (DESIGN §2.1) so the sim can clone it per
 * action, MCTS can roll it forward, the replay can fold it, and the online server
 * can ship it over a socket. A closure cannot be cloned or sent.
 *
 * So a question is a **value**: the engine parks a {@link PendingChoice} in the
 * state, hands the *answering* seat the floor, and resumes the half-finished
 * resolution when an `answerChoice` action arrives. One mechanism serves all three
 * consumers unchanged:
 *   - headless AI sim — the pending choice appears in `generateLegalActions` as
 *     ordinary `answerChoice` actions, so a pilot answers it like any other move;
 *   - hotseat — the UI renders the choice and submits the chosen answer;
 *   - authoritative server — the choice is addressed to exactly one seat, which is
 *     the only seat whose answer the engine accepts.
 *
 * ## The kinds are composable, not per-card
 * Six small kinds cover every "you may / choose / search / modal / unless you pay
 * / at what" question the card pool asks (DESIGN §1 composition over inheritance
 * — no choice type per card):
 *   - {@link SelectCardsChoice}  — pick `min..max` cards from a candidate list,
 *     optionally ORDERED (that is what "put them back in any order" is).
 *   - {@link SelectPlayersChoice} — pick `min..max` players.
 *   - {@link ChooseModesChoice}  — pick `min..max` of the listed modes.
 *   - {@link ConfirmChoice}      — yes/no ("you may …").
 *   - {@link SelectTargetsChoice} — what an ability POINTS AT, chosen as it goes
 *     on the stack. Not a `selectCards`: a target may be a player, and the answer
 *     has to be usable as the stack object's `targets` list.
 *   - {@link PayManaChoice}      — pay a mana cost, or decline ("unless its
 *     controller pays {3}"). It is NOT a `confirm` with a cost in the prompt: the
 *     engine has to know the cost to decide whether paying is even possible, and
 *     to actually spend the mana when the answer says yes.
 *   - {@link PayLifeChoice}      — pay life, or decline (a shockland's "you may
 *     pay 2 life"). Separate from `payMana` for the same reason `payMana` is
 *     separate from `confirm`: the engine charges the price, so it must know it.
 *   - {@link ChooseNumberChoice} — an integer in `[min, max]` ("choose a value
 *     for X" at cast time), with the range computed by the ENGINE from what the
 *     chooser can actually pay.
 *   - {@link ChooseValueChoice}  — NAME a value: a colour, a creature type, a
 *     card type, a player ("As ~ enters, choose a creature type"). Not a
 *     `chooseModes`, because nothing runs when it is answered — the answer is
 *     REMEMBERED on the permanent (`CardInstance.chosenAsEntered`) and read for
 *     as long as it is on the battlefield.
 * Library search is `selectCards` over library candidates plus the shuffle that
 * follows (`EffectContext.shuffleLibrary`), not a kind of its own.
 *
 * ## The invariant that makes hanging impossible
 * Every normalised choice satisfies `0 <= min <= max <= optionCount`, so
 * {@link defaultAnswerFor} always produces a LEGAL answer and
 * {@link enumerateChoiceActions} always returns a non-empty action list. A game
 * can therefore never reach a state where nobody can move.
 */

import type { CardType, EffectRef } from './card.js';
import { colorsOfDefinition, permanentHasSubtype } from './card.js';
import type { ManaColor, ManaCost } from './mana.js';
import type { TargetRestriction } from './targeting.js';
import { convertedManaCost, formatManaCost } from './mana.js';
import type { CardInstance, GameState, InstanceId, PlayerId, ZoneName } from './state.js';
import { PLAYER_IDS, playerZone } from './state.js';

// --- card filters ---------------------------------------------------------------

/**
 * A small, SERIALIZABLE predicate over a card definition — the "nonland card in
 * your hand" / "basic land in your library" half of a choice, expressed as data so
 * a card definition can carry it in an effect's `params` blob and the AI can read
 * the same filter the engine used.
 */
export interface CardFilter {
  /** Keep only cards with at least one of these types (omit ⇒ any type). */
  readonly anyOfTypes?: readonly CardType[];
  /** Drop cards with any of these types (this is how "nonland" is written). */
  readonly noneOfTypes?: readonly CardType[];
  /**
   * Keep only cards carrying at least one of these printed SUBTYPES. This is how
   * "a Mountain or Plains card" and "Goblins" are written — it matches a dual land
   * with those land types, exactly as the printed card does. Compared
   * case-insensitively (see `hasSubtype`).
   */
  readonly anyOfSubtypes?: readonly string[];
  /** Drop cards carrying any of these printed subtypes ("non-Goblin creature"). */
  readonly noneOfSubtypes?: readonly string[];
  /** Exact card name match (case-sensitive, as printed). */
  readonly nameEquals?: string;
  /** Inclusive mana-value bounds. */
  readonly minManaValue?: number;
  readonly maxManaValue?: number;
  /**
   * Inclusive PRINTED power/toughness bounds — "a creature card with toughness 2
   * or less" (Recruiter of the Guard), "with power 4 or greater".
   *
   * PRINTED, not effective: these filters select cards in a LIBRARY, a HAND or a
   * GRAVEYARD, where a card is not a permanent and the continuous layer has
   * nothing to apply. The printed box is the only characteristic that exists.
   *
   * A card with no printed number in the box — a non-creature, or a `*` P/T
   * whose value is a formula ({@link CardDefinition.characteristicPT}) — matches
   * NO power/toughness bound. Treating an absent box as zero would quietly make
   * every Ornithopter and every Tarmogoyf a legal find for "toughness 2 or less",
   * which is not what the printed card says.
   */
  readonly minPower?: number;
  readonly maxPower?: number;
  readonly minToughness?: number;
  readonly maxToughness?: number;
  /**
   * Keep only cards of at least one of these COLORS — how "White creatures you
   * control get +1/+1" narrows an anthem, and available to every other filter
   * consumer (searches, discards, sacrifices) through the same field. Color is
   * derived from the card's mana-cost pips (hybrid included) by
   * {@link colorsOfDefinition} — the one color reader protection also uses, so
   * "white" cannot mean two different things. A card with no colored pips (a
   * land, most artifacts) matches no color and is excluded by any color filter.
   */
  readonly anyOfColors?: readonly ManaColor[];
}

/**
 * Whether a card instance passes a filter. An absent filter matches everything.
 *
 * Written with explicit loops rather than `.some(...)`: static abilities
 * (`statics.ts`) run this for every permanent on the battlefield inside the
 * continuous-layering pass, which combat and every legality check drive, and a
 * closure allocated per predicate per candidate showed up in the hot path.
 */
export function matchesCardFilter(card: CardInstance, filter?: CardFilter): boolean {
  if (!filter) return true;
  const def = card.def;
  // The helper forms are the allocation-free, case-insensitive ones — required by
  // the statics pass that runs this for every permanent, and by subtype matching
  // that must treat "Mountain" and "mountain" alike.
  if (filter.anyOfTypes !== undefined && !hasAnyType(def.types, filter.anyOfTypes)) return false;
  if (filter.noneOfTypes !== undefined && hasAnyType(def.types, filter.noneOfTypes)) return false;
  if (filter.anyOfSubtypes !== undefined && !hasAnySubtype(card, filter.anyOfSubtypes)) return false;
  if (filter.noneOfSubtypes !== undefined && hasAnySubtype(card, filter.noneOfSubtypes)) return false;
  if (filter.nameEquals !== undefined && def.name !== filter.nameEquals) return false;
  if (filter.minManaValue !== undefined || filter.maxManaValue !== undefined) {
    const mv = def.cost ? convertedManaCost(def.cost) : 0;
    if (filter.minManaValue !== undefined && mv < filter.minManaValue) return false;
    if (filter.maxManaValue !== undefined && mv > filter.maxManaValue) return false;
  }
  if (filter.minPower !== undefined || filter.maxPower !== undefined) {
    if (!withinPrintedBox(def.power, filter.minPower, filter.maxPower)) return false;
  }
  if (filter.minToughness !== undefined || filter.maxToughness !== undefined) {
    if (!withinPrintedBox(def.toughness, filter.minToughness, filter.maxToughness)) return false;
  }
  // Colors last: it is the only test that can touch the (memoized) pip walk, so
  // a candidate rejected by type/subtype/name never pays for it at all.
  if (filter.anyOfColors !== undefined && !hasAnyColor(def, filter.anyOfColors)) return false;
  return true;
}

/**
 * Whether a printed power/toughness box falls inside an inclusive bound.
 *
 * An ABSENT box (a non-creature, or a `*` P/T that is a formula rather than a
 * number) is outside every bound — see {@link CardFilter.minPower} for why that
 * is the printed reading and not a conservative guess.
 */
function withinPrintedBox(box: number | undefined, min?: number, max?: number): boolean {
  if (box === undefined) return false;
  if (min !== undefined && box < min) return false;
  if (max !== undefined && box > max) return false;
  return true;
}

/** Whether a definition is any of `wanted` colors. Allocation-free (see above). */
function hasAnyColor(def: CardInstance['def'], wanted: readonly ManaColor[]): boolean {
  const colors = colorsOfDefinition(def);
  for (const want of wanted) {
    for (const color of colors) {
      if (color === want) return true;
    }
  }
  return false;
}

/** Whether a type line carries any of `wanted`. Allocation-free (see above). */
function hasAnyType(types: readonly CardType[], wanted: readonly CardType[]): boolean {
  for (const want of wanted) {
    for (const type of types) {
      if (type === want) return true;
    }
  }
  return false;
}

/**
 * Whether a card carries any of `wanted` as a subtype.
 *
 * Instance-aware ({@link permanentHasSubtype}), not definition-only: a permanent
 * that named a creature type and prints "this creature is the chosen type in
 * addition to its other types" genuinely HAS that type, so a filter that read
 * only the printed line would fail to see one Adaptive Automaton from another.
 * For every card in a hand, library or graveyard the two readings are identical,
 * because nothing there has named anything.
 */
function hasAnySubtype(card: CardInstance, wanted: readonly string[]): boolean {
  for (const want of wanted) {
    if (permanentHasSubtype(card, want)) return true;
  }
  return false;
}

// --- options --------------------------------------------------------------------

/**
 * One selectable card, as a flat SNAPSHOT rather than a live instance reference.
 *
 * The snapshot is the point: a choice travels to a UI (and, online, over a socket
 * to one seat) and must carry everything needed to render itself — including cards
 * that seat cannot otherwise see. Thoughtseize shows the caster's victim their own
 * hand; the masked game view still hides it from everyone else, because the choice
 * is addressed to exactly one `chooser`.
 */
export interface CardOption {
  readonly instanceId: InstanceId;
  /** The card definition's stable id (for art lookup in the UI). */
  readonly cardId: string;
  readonly name: string;
  /** The zone the card was in when the choice was raised. */
  readonly zone: ZoneName;
  /** Who controls/owns it right now. */
  readonly controller: PlayerId;
}

/**
 * WHAT KIND OF THING is being named by a {@link ChooseValueChoice} — the printed
 * noun after "choose a…": a colour, a creature type, a card type, a basic land
 * type, or a player.
 *
 * It rides on the choice (rather than being inferred from the option list)
 * because the ANSWERING POLICY differs per subject and nothing else can tell
 * them apart: a list of five one-letter strings is a colour choice and a list of
 * two seats is a player choice, and a pilot that cannot tell them apart has to
 * guess. See `@jonny-boi/ai`'s `answerChooseValue` for the policy each subject
 * gets and why choosing at random would make these cards noise in an A/B verdict.
 */
export type ChosenValueSubject = 'color' | 'creatureType' | 'cardType' | 'basicLandType' | 'player';

/**
 * The answer that means **nothing was chosen** — the ONE inert default, shared
 * by every path that cannot ask, and explicit rather than accidental (the same
 * discipline as a shockland's "an unasked entry is an unpaid one").
 *
 * Two different paths reach it:
 *  - a permanent that enters where nobody CAN be asked — reanimated, put onto
 *    the battlefield by another card's effect, minted as a token, hand-built in
 *    a test — never records a value at all;
 *  - a parked question that has to degrade (the game ended under the chooser, a
 *    resolution blew its question budget) answers with this.
 *
 * Both leave `CardInstance.chosenAsEntered` absent, and **every reader of a
 * chosen value treats absent as matching nothing**: no creature is of the
 * unchosen type, no card is the unchosen colour, an unchosen mana mode produces
 * nothing. That is the direction that can never play BETTER than the real card,
 * which is the only direction an unasked default is allowed to point.
 */
export const NOTHING_CHOSEN = '';

/** One nameable value on offer ("white", "Goblin", "artifact", "player B"). */
export interface ChoiceValueOption {
  /** Stable id the answer names — a `ManaColor`, a subtype, a `PlayerId`, … */
  readonly value: string;
  /** Human-readable text for the UI / event log. */
  readonly label: string;
}

/** One selectable mode of a modal spell ("counter target spell", "draw a card"). */
export interface ChoiceMode {
  /** Stable id the answer refers to (the primitive maps it back to effects). */
  readonly id: string;
  /** Human-readable text for the UI / event log. */
  readonly label: string;
}

/** Snapshot a live instance as a selectable option. */
export function cardOption(card: CardInstance): CardOption {
  return {
    instanceId: card.instanceId,
    cardId: card.def.id,
    name: card.def.name,
    zone: card.zone,
    controller: card.controller,
  };
}

/**
 * One thing an ability may be aimed at, as a flat snapshot.
 *
 * A target is a permanent OR a player, which is why this is not a
 * {@link CardOption}: the answer has to be usable directly as a stack object's
 * `targets` entry, and half of those entries are seats. `name` is carried so a UI
 * (and a log line) can render the choice without looking anything up.
 */
export interface TargetOption {
  /** What the answer names: a permanent's instance id, or a seat. */
  readonly ref: InstanceId | PlayerId;
  readonly name: string;
  /** Who controls it — the steer an AI uses ("theirs" vs "mine"). */
  readonly controller: PlayerId;
}

/** Snapshot a permanent as a target option. */
export function permanentTargetOption(card: CardInstance): TargetOption {
  return { ref: card.instanceId, name: card.def.name, controller: card.controller };
}

/** Where {@link collectCardOptions} looks and what it keeps. */
export interface CollectOptions {
  /**
   * Restrict to one player's cards: their hand/graveyard/library/exile, or the
   * permanents they control on the (shared) battlefield. Omit for both players.
   */
  readonly controller?: PlayerId;
  readonly filter?: CardFilter;
  /**
   * Keep at most this many. Combined with `fromTop` this is how "look at the top
   * three cards of your library" is expressed.
   */
  readonly limit?: number;
  /**
   * Take from the FRONT of the zone array rather than scanning all of it. A
   * library's front is its top (see `drawCard`), so `{ limit: 3, fromTop: true }`
   * is exactly the top three cards.
   */
  readonly fromTop?: boolean;
}

/**
 * Gather the selectable cards in a zone — the one helper every "choose a card in
 * <zone>" effect uses, so hand / graveyard / battlefield / top-N-of-library all
 * read the same way and stay in candidate order (which is also library order).
 */
export function collectCardOptions(state: GameState, zone: ZoneName, opts: CollectOptions = {}): CardOption[] {
  const out: CardOption[] = [];
  const push = (card: CardInstance): boolean => {
    if (!matchesCardFilter(card, opts.filter)) return true;
    out.push(cardOption(card));
    return opts.limit === undefined || out.length < opts.limit;
  };

  if (zone === 'battlefield') {
    for (const card of state.battlefield) {
      if (opts.controller && card.controller !== opts.controller) continue;
      if (!push(card)) break;
    }
    return out;
  }
  if (zone === 'stack') return out; // stack objects are chosen by their own machinery

  const owners: readonly PlayerId[] = opts.controller ? [opts.controller] : PLAYER_IDS;
  outer: for (const pid of owners) {
    const cards = playerZone(state.players[pid], zone);
    if (!cards) continue;
    // `fromTop` scans the front only — the natural reading of "the top N cards".
    const scan = opts.fromTop && opts.limit !== undefined ? cards.slice(0, opts.limit) : cards;
    for (const card of scan) {
      if (!push(card)) break outer;
    }
  }
  return out;
}

// --- requests (what a card author asks for) --------------------------------------

/**
 * Whether **being selected is good or bad**, from the answering player's point of
 * view. This one hint is what lets an AI answer a card it has never seen, without
 * core or the AI knowing anything about specific cards:
 *
 *   - `'gain'` — selection is favourable. Pick your BEST cards (Eternal Witness
 *     returning a card from your graveyard); pick YOURSELF among players.
 *   - `'loss'` — selection costs you. Pick your WORST cards (Thoughtseize's victim
 *     naming their own discard, Brainstorm choosing two cards to put back); pick
 *     the OPPONENT among players.
 *   - `'neutral'` — no steer; the AI takes the smallest legal selection.
 *
 * It is a hint for answering only — it never affects what answers are legal.
 */
export type ChoiceValence = 'gain' | 'loss' | 'neutral';

/** Fields every request carries. */
interface ChoiceRequestBase {
  /** Who ANSWERS. Not always the controller — Thoughtseize's victim chooses. */
  readonly chooser: PlayerId;
  /** Prompt text for the UI / event log. */
  readonly prompt: string;
  /** Hint for AI answering; see {@link ChoiceValence}. Defaults to `'neutral'`. */
  readonly valence?: ChoiceValence;
}

/**
 * Count bounds, shared by every multi-select request. Resolution (see
 * {@link normalizeCounts}): `max` defaults to `min ?? 1`, `min` defaults to `max`,
 * then both are clamped into `[0, optionCount]`. So `{ max: 2 }` means exactly two,
 * `{ min: 0, max: 2 }` means "up to two" — which is what "you may" looks like on a
 * selection — and omitting both means exactly one.
 */
interface ChoiceCountRequest {
  readonly min?: number;
  readonly max?: number;
}

export interface SelectCardsRequest extends ChoiceRequestBase, ChoiceCountRequest {
  readonly kind: 'selectCards';
  readonly candidates: readonly CardOption[];
  /**
   * When true the ANSWER ORDER is meaningful: the answer lists the chosen cards in
   * the order the effect will use them, FIRST being the position that comes up
   * soonest — the card that ends up on top of the library, is drawn first, is seen
   * first. (An AI therefore orders its picks best-first.) This is what "put them
   * back on top in any order" is; there is no separate "arrange" choice kind.
   */
  readonly ordered?: boolean;
  /** Where the candidates came from; UI copy + AI context only. */
  readonly fromZone?: ZoneName;
  /**
   * Marks the scry/surveil-shaped question: the candidates are the looked-at TOP
   * cards of a library, the chooser picks which of them STAY on top (in order),
   * and every unchosen candidate leaves the top (scry sends it to the bottom,
   * surveil to the graveyard). Like {@link ChoiceRequestBase.valence} this is an
   * ANSWERING hint only — it never changes what answers are legal — but unlike
   * valence it is not a per-card direction: keeping a card is good exactly when
   * that card is worth drawing next, which is a judgement about the card and the
   * board, so the AI needs to know the question's shape to answer it sensibly
   * (bottom lands when flooded, keep the spell it can cast).
   */
  readonly keepOnTop?: boolean;
}

export interface SelectPlayersRequest extends ChoiceRequestBase, ChoiceCountRequest {
  readonly kind: 'selectPlayers';
  readonly candidates: readonly PlayerId[];
}

export interface ChooseModesRequest extends ChoiceRequestBase, ChoiceCountRequest {
  readonly kind: 'chooseModes';
  readonly modes: readonly ChoiceMode[];
  /**
   * "You may choose the same mode more than once." (Fiery Confluence, every
   * Confluence.) Two things change when it is set, and both matter: `max` stops
   * being clamped down to the number of distinct modes, and the answer may
   * repeat a mode id. Absent means the ordinary rule — each mode at most once.
   */
  readonly allowRepeats?: boolean;
}

export interface ConfirmRequest extends ChoiceRequestBase {
  readonly kind: 'confirm';
}

export interface SelectTargetsRequest extends ChoiceRequestBase, ChoiceCountRequest {
  readonly kind: 'selectTargets';
  readonly candidates: readonly TargetOption[];
  /** What may be chosen — carried so a UI can say "a creature" and an AI can reason. */
  readonly restriction: TargetRestriction;
}

export interface PayManaRequest extends ChoiceRequestBase {
  readonly kind: 'payMana';
  /** What paying costs. The chooser either pays this in full or pays nothing. */
  readonly cost: ManaCost;
  /**
   * Whether the chooser can produce that cost right now. **The engine fills this
   * in** (only it can see the mana sources still untappable), so a primitive
   * raising the request leaves it off. A request that arrives without it — one
   * asked outside a resolution, where nobody can tap anything — is treated as
   * unaffordable, which is the answer that spends nothing.
   */
  readonly affordable?: boolean;
}

export interface PayLifeRequest extends ChoiceRequestBase {
  readonly kind: 'payLife';
  /** How much life paying costs. All-or-nothing, exactly like a mana payment. */
  readonly amount: number;
  /**
   * Whether the chooser HAS that much life (CR 118.4 — life may only be paid
   * down to zero, never past it). Filled in by the ENGINE, like
   * {@link PayManaRequest.affordable}; a request that arrives without it is
   * treated as unaffordable, the branch that takes nothing.
   */
  readonly affordable?: boolean;
}

/**
 * Choose an integer in `[min, max]` — the "at what?" question. The engine asks
 * it at cast time for an `{X}` cost ("choose a value for X"), with `max`
 * computed BY THE ENGINE from what the caster could actually pay, so an
 * unpayable X is never on offer (the same honesty rule as
 * {@link PayManaRequest.affordable}). `min` defaults to 0, which is the printed
 * floor for X.
 */
export interface ChooseNumberRequest extends ChoiceRequestBase {
  readonly kind: 'chooseNumber';
  readonly min?: number;
  readonly max: number;
}

/**
 * **Name a value** — "As ~ enters, choose a creature type / a color / a player"
 * (CR 614.1c). Exactly one option is named, and the answer is REMEMBERED on the
 * permanent (`CardInstance.chosenAsEntered`) so the card's own later abilities,
 * and other cards' filters, can read it for as long as it is on the battlefield.
 *
 * It is not a {@link ChooseModesRequest}: a mode is an EFFECT the answer selects
 * and then discards, while this answer is a durable characteristic of the
 * permanent — nothing runs when it is given. It is not a
 * {@link SelectPlayersRequest} for the same reason (Stuffy Doll's chosen player
 * is remembered for the rest of the game, not acted on once), which is why the
 * `'player'` subject lives here rather than being split off.
 */
export interface ChooseValueRequest extends ChoiceRequestBase {
  readonly kind: 'chooseValue';
  readonly subject: ChosenValueSubject;
  readonly options: readonly ChoiceValueOption[];
}

/** Everything a resolving effect may ask. */
export type ChoiceRequest =
  | SelectCardsRequest
  | SelectPlayersRequest
  | ChooseModesRequest
  | ConfirmRequest
  | PayManaRequest
  | PayLifeRequest
  | ChooseNumberRequest
  | ChooseValueRequest
  | SelectTargetsRequest;

/** The kinds, as a discriminator. */
export type ChoiceKind = ChoiceRequest['kind'];

// --- the pending choice (what lives in GameState) ---------------------------------

/** Identity + provenance every parked choice carries. */
interface PendingChoiceBase {
  /**
   * Unique per game. An answer must name it, which is what makes a stale answer
   * (a slow client answering last turn's question) rejectable rather than applied
   * to whatever question happens to be open now.
   */
  readonly id: number;
  readonly chooser: PlayerId;
  readonly prompt: string;
  readonly valence: ChoiceValence;
  /**
   * The spell/permanent that asked, or {@link NO_ASKING_OBJECT} when the
   * question comes from a GAME RULE with no object behind it.
   */
  readonly sourceInstanceId: InstanceId;
  readonly sourceName: string;
  readonly min: number;
  readonly max: number;
  /**
   * What machinery this parked choice belongs to, when it is NOT a resolving
   * effect's question. `'legendRule'` marks the state-based legend-rule choice
   * (CR 704.5j — "choose which to keep"), raised by the SBA pass with no
   * resolution frame behind it; `'cleanupDiscard'` marks the CR 514.1 discard
   * down to maximum hand size, raised by the turn machine; `applyAnswerChoice`
   * routes the answer by this marker instead of guessing from the absence of a
   * frame. Absent for every ordinary choice, so all existing states and tests
   * read unchanged.
   */
  readonly context?: 'legendRule' | 'asEnters' | 'cleanupDiscard';
  /**
   * The permanent whose `chosenAsEntered` an `'asEnters'` answer is written to.
   *
   * It is carried explicitly rather than reusing {@link sourceInstanceId}
   * because the two are only accidentally equal today (the permanent asking IS
   * the permanent remembering), and an answer that wrote to "whatever asked"
   * would silently record the value on the wrong card the first time a source
   * asks on another permanent's behalf. Absent for every other context.
   */
  readonly appliesToInstanceId?: InstanceId;
}

export interface SelectCardsChoice extends PendingChoiceBase {
  readonly kind: 'selectCards';
  readonly candidates: readonly CardOption[];
  readonly ordered: boolean;
  readonly fromZone?: ZoneName;
  /** The scry/surveil shape — see {@link SelectCardsRequest.keepOnTop}. */
  readonly keepOnTop?: boolean;
}

export interface SelectPlayersChoice extends PendingChoiceBase {
  readonly kind: 'selectPlayers';
  readonly candidates: readonly PlayerId[];
}

export interface ChooseModesChoice extends PendingChoiceBase {
  readonly kind: 'chooseModes';
  readonly modes: readonly ChoiceMode[];
  /** Whether one mode may be chosen several times. See the request's note. */
  readonly allowRepeats: boolean;
}

export interface ConfirmChoice extends PendingChoiceBase {
  readonly kind: 'confirm';
}

export interface SelectTargetsChoice extends PendingChoiceBase {
  readonly kind: 'selectTargets';
  readonly candidates: readonly TargetOption[];
  readonly restriction: TargetRestriction;
}

export interface PayManaChoice extends PendingChoiceBase {
  readonly kind: 'payMana';
  readonly cost: ManaCost;
  /**
   * Whether the chooser can produce {@link cost} right now — floating pool plus
   * every mana source they could still tap.
   *
   * This is the field that keeps the choice honest in both directions. False
   * makes declining the ONLY legal answer, so a player who cannot pay is never
   * asked and never accidentally "pays" mana that does not exist; true is what a
   * UI reads to offer the Pay button, and what the engine re-checks before it
   * spends anything.
   */
  readonly affordable: boolean;
}

export interface PayLifeChoice extends PendingChoiceBase {
  readonly kind: 'payLife';
  readonly amount: number;
  /** Whether the chooser can pay — false makes declining the only legal answer. */
  readonly affordable: boolean;
}

/**
 * A number in `[min, max]` — the base's `min`/`max` ARE the numeric range here
 * (not a selection count), so the shared normalisation and validation rules
 * apply unchanged: `min <= answer <= max` always has at least one legal value.
 */
export interface ChooseNumberChoice extends PendingChoiceBase {
  readonly kind: 'chooseNumber';
}

/** Name one value — see {@link ChooseValueRequest}. */
export interface ChooseValueChoice extends PendingChoiceBase {
  readonly kind: 'chooseValue';
  readonly subject: ChosenValueSubject;
  readonly options: readonly ChoiceValueOption[];
}

/** A question parked in `GameState.pendingChoice`, awaiting an `answerChoice`. */
export type PendingChoice =
  | SelectCardsChoice
  | SelectPlayersChoice
  | ChooseModesChoice
  | ConfirmChoice
  | PayManaChoice
  | PayLifeChoice
  | ChooseNumberChoice
  | ChooseValueChoice
  | SelectTargetsChoice;

// --- answers ----------------------------------------------------------------------

export interface SelectCardsAnswer {
  readonly kind: 'selectCards';
  /** Chosen instance ids; ORDER IS THE ANSWER when the choice is `ordered`. */
  readonly instanceIds: readonly InstanceId[];
}
export interface SelectPlayersAnswer {
  readonly kind: 'selectPlayers';
  readonly players: readonly PlayerId[];
}
export interface ChooseModesAnswer {
  readonly kind: 'chooseModes';
  /**
   * The chosen mode ids. On an `allowRepeats` choice a mode may appear several
   * times, and HOW MANY times is part of the answer ("choose two, you may
   * choose the same mode more than once" is two effects, possibly the same one).
   */
  readonly modeIds: readonly string[];
}
export interface ConfirmAnswer {
  readonly kind: 'confirm';
  readonly yes: boolean;
}
export interface SelectTargetsAnswer {
  readonly kind: 'selectTargets';
  /** The chosen target references, in the order the effect will use them. */
  readonly targets: ReadonlyArray<InstanceId | PlayerId>;
}
export interface PayManaAnswer {
  readonly kind: 'payMana';
  /**
   * True = "I pay". The mana is spent by the ENGINE as it accepts this answer,
   * not by the effect that asked — a primitive is re-run from the top when its
   * question is answered (see `ResolutionFrame`), so a payment it made itself
   * would be made again on every later question in the same effect.
   */
  readonly pay: boolean;
}

export interface PayLifeAnswer {
  readonly kind: 'payLife';
  /**
   * True = "I pay". Like {@link PayManaAnswer.pay}, the life is deducted by the
   * ENGINE as it accepts this answer — an effect re-run to collect a later
   * question must never charge twice.
   */
  readonly pay: boolean;
}

export interface ChooseNumberAnswer {
  readonly kind: 'chooseNumber';
  /**
   * The chosen value. For an `{X}` cast the ENGINE charges `value × xCost`
   * generic mana as it accepts this answer — same one-charge rule as the two
   * payment kinds — and what the spell then resolves with is what was paid.
   */
  readonly value: number;
}

export interface ChooseValueAnswer {
  readonly kind: 'chooseValue';
  /**
   * The named option's `value`, or {@link NOTHING_CHOSEN} — which is always a
   * legal answer, for the same reason declining a payment always is: it is the
   * branch that cannot take anything the chooser did not agree to, and here it
   * is also the exact value every unaskable entry path records. One inert
   * default, spelled the same way everywhere.
   */
  readonly value: string;
}

/** What an `answerChoice` action carries. Plain data — clones and serializes. */
export type ChoiceAnswer =
  | SelectCardsAnswer
  | SelectPlayersAnswer
  | ChooseModesAnswer
  | ConfirmAnswer
  | PayManaAnswer
  | PayLifeAnswer
  | ChooseNumberAnswer
  | ChooseValueAnswer
  | SelectTargetsAnswer;

// --- normalisation ----------------------------------------------------------------

/**
 * How many options a choice offers (two for a yes/no) — one answer to that
 * question, used by the event log, the inspector dump, and anything else that
 * wants to describe a choice without unpacking its payload.
 */
export function choiceOptionCount(choice: PendingChoice): number {
  switch (choice.kind) {
    case 'selectCards':
      return choice.candidates.length;
    case 'selectPlayers':
      return choice.candidates.length;
    case 'selectTargets':
      return choice.candidates.length;
    case 'chooseModes':
      return choice.modes.length;
    case 'confirm':
      return CONFIRM_OPTION_COUNT;
    case 'payMana':
      // Declining is always on offer; paying only when the mana is actually there.
      return choice.affordable ? CONFIRM_OPTION_COUNT : DECLINE_ONLY_OPTION_COUNT;
    case 'payLife':
      return choice.affordable ? CONFIRM_OPTION_COUNT : DECLINE_ONLY_OPTION_COUNT;
    case 'chooseNumber':
      // min..max inclusive — the range IS the option list.
      return choice.max - choice.min + 1;
    case 'chooseValue':
      return choice.options.length;
    default:
      return 0;
  }
}

/** A yes/no offers exactly two answers. Named so no bare `2` appears in logic. */
const CONFIRM_OPTION_COUNT = 2;

/** A payment nobody can afford offers one: decline. */
const DECLINE_ONLY_OPTION_COUNT = 1;

/** Resolve + clamp `{min,max}` so `0 <= min <= max <= optionCount` always holds. */
function normalizeCounts(request: ChoiceCountRequest, optionCount: number): { min: number; max: number } {
  const requestedMax = request.max ?? request.min ?? DEFAULT_CHOICE_COUNT;
  const requestedMin = request.min ?? requestedMax;
  const max = Math.max(0, Math.min(requestedMax, optionCount));
  const min = Math.max(0, Math.min(requestedMin, max));
  return { min, max };
}

/** With neither bound given, a selection asks for exactly one option. */
const DEFAULT_CHOICE_COUNT = 1;

/**
 * The `sourceInstanceId` a question raised by a GAME RULE carries — the CR 514.1
 * cleanup discard, and anything else the turn machine has to ask that no card
 * asked for.
 *
 * Negative on purpose: instance ids are minted upward from 1 as libraries are
 * built (`paired-arms-config.ts` pins that), so this can never collide with a
 * real card, and every "look this id up" path (`findInstance`, the UI's card
 * lookup) already answers `undefined` for an id it does not hold and degrades to
 * naming the choice by its {@link ChoiceSource.sourceName} instead.
 */
export const NO_ASKING_OBJECT: InstanceId = -1;

/** Provenance stamped onto a normalised choice. */
export interface ChoiceSource {
  readonly id: number;
  readonly sourceInstanceId: InstanceId;
  readonly sourceName: string;
}

/**
 * Turn a request into a parkable {@link PendingChoice}, clamping the counts to the
 * options actually available. Returns `null` for a request whose `kind` this build
 * does not know — the caller degrades safely rather than crashing (a state written
 * by a newer build, or a hand-rolled request, must never take the engine down).
 */
export function normalizeChoiceRequest(request: ChoiceRequest, source: ChoiceSource): PendingChoice | null {
  const valence = request.valence ?? 'neutral';
  const base = {
    id: source.id,
    chooser: request.chooser,
    prompt: request.prompt,
    valence,
    sourceInstanceId: source.sourceInstanceId,
    sourceName: source.sourceName,
  };
  switch (request.kind) {
    case 'selectCards': {
      const { min, max } = normalizeCounts(request, request.candidates.length);
      return {
        ...base,
        kind: 'selectCards',
        candidates: [...request.candidates],
        ordered: request.ordered ?? false,
        min,
        max,
        ...(request.fromZone ? { fromZone: request.fromZone } : {}),
        ...(request.keepOnTop ? { keepOnTop: true } : {}),
      };
    }
    case 'selectPlayers': {
      const { min, max } = normalizeCounts(request, request.candidates.length);
      return { ...base, kind: 'selectPlayers', candidates: [...request.candidates], min, max };
    }
    case 'selectTargets': {
      const { min, max } = normalizeCounts(request, request.candidates.length);
      return {
        ...base,
        kind: 'selectTargets',
        candidates: request.candidates.map((c) => ({ ...c })),
        restriction: request.restriction,
        min,
        max,
      };
    }
    case 'chooseModes': {
      // With repeats allowed one mode can fill every slot, so the option COUNT
      // no longer bounds the pick count — the printed number does. Clamping to
      // `modes.length` there would silently shrink "choose three" on a two-mode
      // Confluence, i.e. play the card as weaker than printed.
      const allowRepeats = request.allowRepeats === true && request.modes.length > 0;
      const { min, max } = normalizeCounts(request, allowRepeats ? MAX_REPEATED_MODE_PICKS : request.modes.length);
      return {
        ...base,
        kind: 'chooseModes',
        modes: request.modes.map((m) => ({ id: m.id, label: m.label })),
        allowRepeats,
        min,
        max,
      };
    }
    case 'confirm':
      return { ...base, kind: 'confirm', min: 1, max: 1 };
    case 'payMana':
      return {
        ...base,
        kind: 'payMana',
        // Copied, not aliased: the request's cost usually IS a card definition's
        // frozen cost object, and a parked choice outlives the call that raised it.
        cost: { ...request.cost },
        affordable: request.affordable ?? false,
        min: 1,
        max: 1,
      };
    case 'payLife':
      return {
        ...base,
        kind: 'payLife',
        amount: request.amount,
        affordable: request.affordable ?? false,
        min: 1,
        max: 1,
      };
    case 'chooseNumber': {
      // The base's min/max carry the NUMERIC RANGE. Clamped so `0 <= min <= max`
      // always holds — a malformed request degrades to the single value 0 rather
      // than to a question with no legal answer.
      const max = Math.max(0, Math.trunc(request.max));
      const min = Math.max(0, Math.min(Math.trunc(request.min ?? 0), max));
      return { ...base, kind: 'chooseNumber', min, max };
    }
    case 'chooseValue':
      // Exactly one value is named, always — the count bounds are `1..1` and
      // are not negotiable, so there is no `normalizeCounts` call to make.
      // Options are COPIED for the same reason a `payMana` cost is: the request's
      // list is usually a frozen table on a card definition, and a parked choice
      // outlives the call that raised it.
      return {
        ...base,
        kind: 'chooseValue',
        subject: request.subject,
        options: request.options.map((option) => ({ value: option.value, label: option.label })),
        min: 1,
        max: 1,
      };
    default:
      return null;
  }
}

// --- validation --------------------------------------------------------------------

/** The verdict on a submitted answer. */
export type AnswerValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const VALID: AnswerValidation = { ok: true };

function invalid(reason: string): AnswerValidation {
  return { ok: false, reason };
}

/** Shared count + duplicate + membership check for the list-shaped kinds. */
function validateSelection<T>(
  chosen: readonly T[],
  allowed: readonly T[],
  min: number,
  max: number,
  noun: string,
): AnswerValidation {
  if (!Array.isArray(chosen)) return invalid(`the ${noun} selection must be a list`);
  if (chosen.length < min) return invalid(`choose at least ${min} ${noun}(s)`);
  if (chosen.length > max) return invalid(`choose at most ${max} ${noun}(s)`);
  const seen = new Set<T>();
  for (const item of chosen) {
    if (seen.has(item)) return invalid(`${noun} ${String(item)} was chosen more than once`);
    seen.add(item);
    if (!allowed.includes(item)) return invalid(`${String(item)} is not one of the offered ${noun}s`);
  }
  return VALID;
}

/**
 * Whether an answer legally answers a choice. Rejection is CLEAN: the caller
 * refuses the action and leaves the pending choice exactly as it was, so a
 * malformed or hostile answer (the online server's wire is untrusted) can never
 * corrupt state or advance the game.
 */
export function validateChoiceAnswer(choice: PendingChoice, answer: ChoiceAnswer): AnswerValidation {
  if (!answer || typeof answer !== 'object') return invalid('the answer is not a choice answer');
  if (answer.kind !== choice.kind) return invalid(`expected a ${choice.kind} answer, got ${String(answer.kind)}`);
  switch (choice.kind) {
    case 'selectCards':
      return validateSelection(
        (answer as SelectCardsAnswer).instanceIds,
        choice.candidates.map((c) => c.instanceId),
        choice.min,
        choice.max,
        'card',
      );
    case 'selectPlayers':
      return validateSelection(
        (answer as SelectPlayersAnswer).players,
        choice.candidates,
        choice.min,
        choice.max,
        'player',
      );
    case 'selectTargets':
      return validateSelection(
        (answer as SelectTargetsAnswer).targets,
        choice.candidates.map((c) => c.ref),
        choice.min,
        choice.max,
        'target',
      );
    case 'chooseModes': {
      const ids = (answer as ChooseModesAnswer).modeIds;
      if (!choice.allowRepeats) {
        return validateSelection(
          ids,
          choice.modes.map((m) => m.id),
          choice.min,
          choice.max,
          'mode',
        );
      }
      // The repeats form shares the count and membership rules and drops only
      // the duplicate rule, so it is spelled out here rather than bent into
      // `validateSelection` behind a flag no other caller would ever pass.
      if (!Array.isArray(ids)) return invalid('the mode selection must be a list');
      if (ids.length < choice.min) return invalid(`choose at least ${choice.min} mode(s)`);
      if (ids.length > choice.max) return invalid(`choose at most ${choice.max} mode(s)`);
      for (const id of ids) {
        if (!choice.modes.some((mode) => mode.id === id)) {
          return invalid(`${String(id)} is not one of the offered modes`);
        }
      }
      return VALID;
    }
    case 'confirm':
      return typeof (answer as ConfirmAnswer).yes === 'boolean' ? VALID : invalid('a yes/no answer must be a boolean');
    case 'payMana': {
      const pay = (answer as PayManaAnswer).pay;
      if (typeof pay !== 'boolean') return invalid('a pay/decline answer must be a boolean');
      // Agreeing to pay mana the board cannot produce is rejected rather than
      // silently downgraded to a decline: the answer is wrong about the game, and
      // an engine that quietly reinterprets it would hide the disagreement.
      if (pay && !choice.affordable) return invalid(`you cannot produce ${formatManaCost(choice.cost)}`);
      return VALID;
    }
    case 'payLife': {
      const pay = (answer as PayLifeAnswer).pay;
      if (typeof pay !== 'boolean') return invalid('a pay/decline answer must be a boolean');
      // Life may only be paid down to zero (CR 118.4) — same refusal as payMana.
      if (pay && !choice.affordable) return invalid(`you do not have ${choice.amount} life to pay`);
      return VALID;
    }
    case 'chooseNumber': {
      const value = (answer as ChooseNumberAnswer).value;
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return invalid('the chosen value must be a whole number');
      }
      // The range was computed from what the chooser could actually pay, so a
      // value outside it is an X the board cannot fund — refused, not clamped.
      if (value < choice.min || value > choice.max) {
        return invalid(`choose a value between ${choice.min} and ${choice.max}`);
      }
      return VALID;
    }
    case 'chooseValue': {
      const named = (answer as ChooseValueAnswer).value;
      if (typeof named !== 'string') return invalid('the chosen value must be a name');
      // Naming nothing is always legal — it is the inert default every unaskable
      // entry path already records, so the two can never disagree.
      if (named === NOTHING_CHOSEN) return VALID;
      if (!choice.options.some((option) => option.value === named)) {
        return invalid(`${named} is not one of the offered choices`);
      }
      return VALID;
    }
    default:
      return invalid('unknown choice kind');
  }
}

// --- default / degraded answers ------------------------------------------------------

/**
 * A guaranteed-legal answer to any choice — the first `min` options, or "no".
 *
 * This is the engine's floor: it is what a choice degrades to when the chooser
 * cannot answer (the game ended under them, a state arrived from a newer build,
 * a primitive asked more questions than {@link MAX_CHOICES_PER_RESOLUTION}). It is
 * always legal because normalisation guarantees `min <= optionCount`, which is
 * exactly why an unanswerable choice cannot exist.
 */
export function defaultAnswerFor(choice: PendingChoice): ChoiceAnswer {
  switch (choice.kind) {
    case 'selectCards':
      return { kind: 'selectCards', instanceIds: choice.candidates.slice(0, choice.min).map((c) => c.instanceId) };
    case 'selectPlayers':
      return { kind: 'selectPlayers', players: choice.candidates.slice(0, choice.min) };
    case 'selectTargets':
      return { kind: 'selectTargets', targets: choice.candidates.slice(0, choice.min).map((c) => c.ref) };
    case 'chooseModes': {
      // With repeats allowed the first mode can legally fill every required
      // slot, which is what makes a floor of three satisfiable on a two-mode
      // card. Without them it is the first `min` distinct modes, as ever.
      if (choice.allowRepeats && choice.modes.length > 0) {
        const first = (choice.modes[0] as ChoiceMode).id;
        return { kind: 'chooseModes', modeIds: new Array<string>(choice.min).fill(first) };
      }
      return { kind: 'chooseModes', modeIds: choice.modes.slice(0, choice.min).map((m) => m.id) };
    }
    case 'confirm':
      // Declining is the no-op branch of "you may", so it is the safe default.
      return { kind: 'confirm', yes: false };
    case 'payMana':
      // Never spend mana on the chooser's behalf. Declining is always legal, and
      // it is the only branch that cannot take something the chooser did not agree
      // to give — the reason this is safe as the degraded answer.
      return { kind: 'payMana', pay: false };
    case 'payLife':
      // Same rule, higher stakes: life is never taken without a yes.
      return { kind: 'payLife', pay: false };
    case 'chooseNumber':
      // The smallest legal value — for an X cost that is X = 0, the answer that
      // spends nothing on the chooser's behalf (same rule as the payment kinds).
      return { kind: 'chooseNumber', value: choice.min };
    case 'chooseValue':
      // Name NOTHING — unless exactly one value is on offer, which is not a
      // decision but the only lawful naming (the same rule `selectTargets`
      // applies to a single legal target).
      //
      // Deliberately NOT "the first option" in general: that would be an
      // arbitrary pick dressed up as a default, and on a Cavern of Souls it
      // would silently hand the degraded path a real, working creature type.
      // See {@link NOTHING_CHOSEN} — the unasked default is the one that grants
      // nothing, and it is the same value on every path that cannot ask.
      return {
        kind: 'chooseValue',
        value: choice.options.length === 1 ? (choice.options[0] as ChoiceValueOption).value : NOTHING_CHOSEN,
      };
    default:
      return { kind: 'confirm', yes: false };
  }
}

/**
 * Whether a choice has exactly ONE legal answer, in which case asking is theatre:
 * the engine answers it itself (emitting `choiceAutoAnswered`) instead of stopping
 * the game to collect the only possible reply. This is also what makes a choice
 * whose objects have all left the zone resolve safely — zero candidates is the
 * degenerate single answer "none".
 */
export function isTrivialChoice(choice: PendingChoice): boolean {
  switch (choice.kind) {
    case 'selectCards':
      // With an order to pick there are `n!` answers, so only 0 or 1 card is trivial.
      if (choice.ordered && choice.max > 1) return false;
      return choice.min === choice.max && (choice.min === 0 || choice.min === choice.candidates.length);
    case 'selectPlayers':
      return choice.min === choice.max && (choice.min === 0 || choice.min === choice.candidates.length);
    case 'selectTargets':
      // One legal target is not a decision, it is the only lawful aim — the engine
      // takes it rather than stopping the game. (Two or more genuinely IS a
      // decision and must be asked: auto-picking there would make a card report
      // as playable and then fizzle the moment the board grew a second option.)
      return choice.min === choice.max && (choice.min === 0 || choice.min === choice.candidates.length);
    case 'chooseModes':
      if (choice.min !== choice.max) return false;
      if (choice.min === 0) return true;
      // With repeats, a ONE-mode menu has exactly one legal answer whatever the
      // count ("choose two" of one mode is that mode twice). Without them, the
      // only forced answer is "take them all".
      return choice.allowRepeats ? choice.modes.length === 1 : choice.min === choice.modes.length;
    case 'confirm':
      return false;
    case 'payMana':
      // A cost the chooser cannot produce has exactly one legal answer, so the
      // engine takes it instead of stopping the game to collect the inevitable.
      // This is also what stops a "pays {3}" clause from interrupting a game in
      // which nobody could ever have paid.
      return !choice.affordable;
    case 'payLife':
      return !choice.affordable;
    case 'chooseNumber':
      // A range of one value is not a decision — notably X on a board that can
      // only fund X = 0, which must not stop the game to ask the inevitable.
      return choice.min === choice.max;
    case 'chooseValue':
      // One option is not a decision. ZERO options is the degenerate case
      // ("choose a creature type" with no type list to offer) and settles to
      // "nothing chosen" without stopping the game. Two or more IS a decision
      // and is always asked: auto-picking a colour would make Coldsteel Heart
      // produce a colour its controller never named.
      return choice.options.length <= 1;
    default:
      return true;
  }
}

/**
 * A hard ceiling on how many questions ONE resolution may ask. A primitive with a
 * bug (asking inside a loop whose condition its own answer never changes) would
 * otherwise wedge the game forever; instead the engine abandons the rest of that
 * resolution with an event. Generous: no real card comes close.
 */
export const MAX_CHOICES_PER_RESOLUTION = 32;

// --- answer enumeration (the AI / legal-action seam) ------------------------------

/**
 * How many candidate answers `generateLegalActions` will enumerate for one choice.
 *
 * Enumeration must be BOUNDED — "choose up to three of my twelve cards" has 299
 * subsets and an ordered pick has factorially many — but it must also never be
 * empty. So the engine offers a bounded, representative menu and `applyAction`
 * accepts ANY valid answer besides. That is the same contract combat already uses:
 * `declareAttackers` offers "attack with everyone" while the engine accepts any
 * legal subset a pilot constructs itself.
 */
export const MAX_ENUMERATED_CHOICE_ANSWERS = 24;

/**
 * Subsets of `items` sized `min..max`, in a stable order and capped at `limit`.
 * Deterministic: the same inputs always yield the same list in the same order (no
 * RNG, no iteration over a hash), which is what keeps a seeded sim reproducible.
 */
function boundedSubsets<T>(items: readonly T[], min: number, max: number, limit: number): T[][] {
  const out: T[][] = [];
  const current: T[] = [];
  const walk = (start: number): void => {
    if (out.length >= limit) return;
    if (current.length >= min) out.push([...current]);
    if (current.length >= max) return;
    for (let i = start; i < items.length; i++) {
      if (out.length >= limit) return;
      current.push(items[i] as T);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return out;
}

/**
 * Multisets of `items` sized `min..max` — subsets that MAY repeat an item, for
 * "you may choose the same mode more than once". Non-decreasing by index, so
 * each combination appears exactly once and the order is deterministic (the
 * same seeded sim reproduces the same menu).
 */
function boundedMultisets<T>(items: readonly T[], min: number, max: number, limit: number): T[][] {
  const out: T[][] = [];
  const current: T[] = [];
  const walk = (start: number): void => {
    if (out.length >= limit) return;
    if (current.length >= min) out.push([...current]);
    if (current.length >= max) return;
    for (let i = start; i < items.length; i++) {
      if (out.length >= limit) return;
      current.push(items[i] as T);
      // `i`, not `i + 1` — that one character is the whole difference from
      // `boundedSubsets`: an item may be taken again.
      walk(i);
      current.pop();
    }
  };
  walk(0);
  return out;
}

/**
 * The ceiling on a repeated-mode pick count. Real cards choose two or three;
 * this exists so a malformed record cannot normalise into an unbounded
 * enumeration.
 */
const MAX_REPEATED_MODE_PICKS = 16;

/**
 * The answers a pilot may pick from for a pending choice — always at least one.
 *
 * For an ORDERED selection we enumerate each subset in candidate order only; a
 * pilot that cares about the order (the heuristic does) constructs the permutation
 * it wants and submits it directly, exactly as it constructs its own block
 * assignments.
 */
export function enumerateChoiceAnswers(choice: PendingChoice): ChoiceAnswer[] {
  const limit = MAX_ENUMERATED_CHOICE_ANSWERS;
  switch (choice.kind) {
    case 'selectCards': {
      const ids = choice.candidates.map((c) => c.instanceId);
      const answers = boundedSubsets(ids, choice.min, choice.max, limit).map(
        (instanceIds): ChoiceAnswer => ({ kind: 'selectCards', instanceIds }),
      );
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    case 'selectPlayers': {
      const answers = boundedSubsets(choice.candidates, choice.min, choice.max, limit).map(
        (players): ChoiceAnswer => ({ kind: 'selectPlayers', players }),
      );
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    case 'selectTargets': {
      const refs = choice.candidates.map((c) => c.ref);
      const answers = boundedSubsets(refs, choice.min, choice.max, limit).map(
        (targets): ChoiceAnswer => ({ kind: 'selectTargets', targets }),
      );
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    case 'chooseModes': {
      const ids = choice.modes.map((m) => m.id);
      const combos = choice.allowRepeats
        ? boundedMultisets(ids, choice.min, choice.max, limit)
        : boundedSubsets(ids, choice.min, choice.max, limit);
      const answers = combos.map((modeIds): ChoiceAnswer => ({ kind: 'chooseModes', modeIds }));
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    case 'confirm':
      return [
        { kind: 'confirm', yes: true },
        { kind: 'confirm', yes: false },
      ];
    case 'payMana':
      // Paying is only offered when it is legal; declining always is.
      return choice.affordable
        ? [
            { kind: 'payMana', pay: true },
            { kind: 'payMana', pay: false },
          ]
        : [{ kind: 'payMana', pay: false }];
    case 'payLife':
      return choice.affordable
        ? [
            { kind: 'payLife', pay: true },
            { kind: 'payLife', pay: false },
          ]
        : [{ kind: 'payLife', pay: false }];
    case 'chooseNumber': {
      // Ascending from min, capped like every other enumeration. The cap cannot
      // starve anyone: `max` is bounded by what the board can pay, which no real
      // board pushes past the enumeration limit — and `applyAction` accepts any
      // valid value besides, exactly as it does for attack subsets.
      const answers: ChoiceAnswer[] = [];
      for (let value = choice.min; value <= choice.max && answers.length < limit; value++) {
        answers.push({ kind: 'chooseNumber', value });
      }
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    case 'chooseValue': {
      // Every offered value, capped like the rest. `NOTHING_CHOSEN` is legal but
      // is NOT enumerated: it is the floor for a path that cannot ask, not a
      // move a pilot should ever be handed a reason to take.
      const answers = choice.options
        .slice(0, limit)
        .map((option): ChoiceAnswer => ({ kind: 'chooseValue', value: option.value }));
      return answers.length > 0 ? answers : [defaultAnswerFor(choice)];
    }
    default:
      return [defaultAnswerFor(choice)];
  }
}

/**
 * Copy an answer so nothing downstream aliases the caller's action object. An
 * answer arrives from outside the engine — a pilot, a UI, a network peer — and is
 * stored in both the event log and the suspended frame; sharing the array would
 * let a caller mutate history after the fact.
 */
export function cloneChoiceAnswer(answer: ChoiceAnswer): ChoiceAnswer {
  switch (answer.kind) {
    case 'selectCards':
      return { kind: 'selectCards', instanceIds: [...answer.instanceIds] };
    case 'selectPlayers':
      return { kind: 'selectPlayers', players: [...answer.players] };
    case 'selectTargets':
      return { kind: 'selectTargets', targets: [...answer.targets] };
    case 'chooseModes':
      return { kind: 'chooseModes', modeIds: [...answer.modeIds] };
    default:
      return { ...answer };
  }
}

/** A compact, log-friendly rendering of an answer (used by the event log/inspector). */
export function describeChoiceAnswer(answer: ChoiceAnswer): string {
  switch (answer.kind) {
    case 'selectCards':
      return answer.instanceIds.length === 0 ? 'no cards' : `cards [${answer.instanceIds.join(', ')}]`;
    case 'selectPlayers':
      return answer.players.length === 0 ? 'no players' : `players [${answer.players.join(', ')}]`;
    case 'selectTargets':
      return answer.targets.length === 0 ? 'no targets' : `targets [${answer.targets.join(', ')}]`;
    case 'chooseModes':
      return answer.modeIds.length === 0 ? 'no modes' : `modes [${answer.modeIds.join(', ')}]`;
    case 'confirm':
      return answer.yes ? 'yes' : 'no';
    case 'payMana':
      return answer.pay ? 'paid' : 'declined to pay';
    case 'payLife':
      return answer.pay ? 'paid life' : 'declined to pay life';
    case 'chooseNumber':
      return `chose ${answer.value}`;
    case 'chooseValue':
      return answer.value === NOTHING_CHOSEN ? 'chose nothing' : `named ${answer.value}`;
    default:
      return 'answer';
  }
}

// --- the suspended-resolution frame ------------------------------------------------

/**
 * A resolution caught mid-flight, so it can be finished later from plain data.
 *
 * When an effect asks a question, the resolution cannot simply continue — but nor
 * may it be thrown away: the spell is half-resolved and MUST finish (and end up in
 * the right zone) once the answer arrives. The frame is that bookmark: the effect
 * refs still to run, the answers already collected for the one in progress, and
 * the card in limbo between the stack and its destination.
 *
 * It is plain data for the same reason the choice is: it clones, serializes, and
 * replays. There is no continuation, no closure, no promise.
 */
export interface ResolutionFrame {
  /** A spell resolving, or a triggered ability. */
  readonly origin: 'spell' | 'trigger';
  readonly controller: PlayerId;
  /** Targets chosen when the object went on the stack. */
  readonly targets: ReadonlyArray<InstanceId | PlayerId>;
  /** Effect refs for this resolution; `next` indexes the one in progress. */
  effects: EffectRef[];
  next: number;
  /**
   * Answers collected for the effect ref at `next`, in ask order. Re-running that
   * ref replays its questions from here, so it reaches the point it stopped at
   * without asking again — the reason a primitive must ask BEFORE it mutates.
   */
  answers: ChoiceAnswer[];
  /** Questions asked across the whole frame; guards {@link MAX_CHOICES_PER_RESOLUTION}. */
  askCount: number;
  /** The spell card mid-resolution (absent for a trigger). */
  card?: CardInstance;
  /**
   * Where that card goes when the resolution finishes — exile for flashback,
   * HAND for a bought-back spell. Computed once, as the resolution begins, by
   * `spellLeaveDestination`, so the frame that outlives the stack object still
   * carries the one agreed answer.
   */
  resolvesTo?: 'battlefield' | 'graveyard' | 'exile' | 'hand';
  /**
   * The value chosen for `{X}` when this spell was cast — carried off the stack
   * object so "deals X damage" still reads the paid-for number AFTER the spell
   * has left the stack (a resolution outlives its stack object). Absent for
   * spells without an X cost and for triggers.
   */
  xValue?: number;
  /** Whether the kicker was paid at cast time. Absent when there is no kicker. */
  kicked?: boolean;
  /**
   * How many times the MULTIKICKER was paid at cast time, carried off the
   * stack object for the same reason as {@link xValue}: "for each time it was
   * kicked" is read during a resolution that outlives the stack object.
   */
  kickCount?: number;
  /**
   * PER-EFFECT targets, parallel to {@link effects} — entry `i` is what
   * `effects[i]` points at, or `undefined` to fall back to the frame-wide
   * {@link targets}.
   *
   * This exists for exactly one reason: a MODAL spell's chosen modes each
   * aim at their own object ("Counter target spell" + "Return target permanent
   * to its owner's hand" is two different targets in one resolution), which
   * one frame-wide list cannot express. Everything else leaves it absent and
   * reads `targets` exactly as before.
   *
   * ⚠️ It is a PARALLEL ARRAY, so anything that splices `effects` must splice
   * this in lockstep — `enqueueEffects` does, and a test pins it. The
   * alternative (an object per effect) would have changed a shape every
   * consumer, every clone and every serialized state already agrees on.
   */
  effectTargets?: Array<ReadonlyArray<InstanceId | PlayerId> | undefined>;
  /** The ability's source permanent + label (trigger frames only). */
  sourceInstanceId?: InstanceId;
  label?: string;
  /**
   * The player the trigger's event was about — carried off the stack object for
   * the same reason as {@link xValue}: the resolution outlives the stack object,
   * and "that player draws an additional card" is read during it. Absent for
   * spells and for triggers whose event names no player.
   */
  triggeringPlayer?: PlayerId;
}
