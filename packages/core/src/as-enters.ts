/**
 * **"As ~ enters, choose a…"** — the value a permanent NAMES as it enters
 * (CR 614.1c), and everything that reads it back.
 *
 * ## The crux is the memory, not the prompt
 * Asking "which creature type?" is the easy half. What makes Cavern of Souls a
 * card rather than a question is that the answer sticks to the permanent and is
 * still readable ten turns later — by the card's own static ("creatures you
 * control **of the chosen type** get +1/+1"), by its own mana ability ("add one
 * mana **of the chosen color**"), and by its own type line ("this creature **is
 * the chosen type** in addition to its other types"). So the answer is stored on
 * the INSTANCE (`CardInstance.chosenAsEntered`) and every consumer reads it
 * through the accessors here, rather than each inventing its own reading.
 *
 * ## When it is asked, and what happens when nobody can be asked
 * The naming happens WHILE the permanent is entering — the same moment "enters
 * with N +1/+1 counters" applies — so it is raised by the two paths that hold a
 * permanent mid-entry and can still park a question:
 *  - **playing a land** (`engine.ts`, beside the shockland's `payLife`), and
 *  - **a permanent spell resolving** (the compiler puts the `chooseAsEnters`
 *    primitive first in the card's script, so it runs against the entering
 *    instance before `finishSpellResolution` puts it on the battlefield).
 *
 * Every OTHER entry path — reanimation, another card's "put it onto the
 * battlefield", a token, a hand-built test instance — cannot ask, and **records
 * nothing**. That is the shockland's rule applied to a naming: the unasked
 * default is explicit, it is the same value everywhere (`NOTHING_CHOSEN`), and
 * it is the one that can never grant an advantage, because *every* reader here
 * treats "nothing named" as matching nothing rather than as matching everything.
 *
 * ## Where the option lists come from
 * Colours, basic land types and players are fixed, known sets. CREATURE TYPES
 * are not — Magic has hundreds — so the menu is derived from the game: the types
 * printed on cards the CHOOSER owns, plus everything on the battlefield. A
 * player genuinely knows their own decklist, so this offers no information they
 * do not have, and it is what makes the choice meaningful rather than a
 * thousand-item list nobody can answer sensibly (see `@jonny-boi/ai`'s
 * `answerChooseValue` for the answering policy built on top of it).
 */

import type { AsEntersChoice, CardDefinition, ChoiceBearingPermanent } from './card.js';
import type { ChoiceValueOption, ChosenValueSubject } from './choices.js';
import { NOTHING_CHOSEN } from './choices.js';
import type { GameEvent } from './events.js';
import type { ManaColor } from './mana.js';
import type { CardInstance, GameState, PlayerId } from './state.js';
import { PLAYER_IDS } from './state.js';

/** The five colours a card may name, in canonical order, with printed words. */
const COLOR_OPTIONS: readonly ChoiceValueOption[] = Object.freeze([
  { value: 'W', label: 'white' },
  { value: 'U', label: 'blue' },
  { value: 'B', label: 'black' },
  { value: 'R', label: 'red' },
  { value: 'G', label: 'green' },
]);

/**
 * "Choose a color" never offers colourless. `MANA_COLORS` includes `'C'` because
 * it indexes a mana pool; a COLOUR, as the game uses the word, is one of five
 * (CR 105.1) — and a Coldsteel Heart that could name colourless would be a
 * strictly better card than the printed one.
 */
export const CHOOSABLE_COLORS: readonly ManaColor[] = Object.freeze(
  COLOR_OPTIONS.map((option) => option.value as ManaColor),
);

/** The five basic land types, for "choose a basic land type". */
const BASIC_LAND_TYPE_OPTIONS: readonly ChoiceValueOption[] = Object.freeze([
  { value: 'Plains', label: 'Plains' },
  { value: 'Island', label: 'Island' },
  { value: 'Swamp', label: 'Swamp' },
  { value: 'Mountain', label: 'Mountain' },
  { value: 'Forest', label: 'Forest' },
]);

/** The printed noun each subject names, for a prompt the card did not write. */
const SUBJECT_NOUNS: Readonly<Record<ChosenValueSubject, string>> = Object.freeze({
  color: 'a color',
  creatureType: 'a creature type',
  cardType: 'a card type',
  basicLandType: 'a basic land type',
  player: 'a player',
});

/** The prompt for a naming — the card's own words when it wrote any. */
export function asEntersPrompt(def: CardDefinition, choice: AsEntersChoice): string {
  return choice.prompt ?? `As ${def.name} enters, choose ${SUBJECT_NOUNS[choice.subject]}`;
}

/**
 * The values `chooser` may name for this permanent, in a deterministic order.
 *
 * Deterministic is a requirement, not a nicety: the list becomes a
 * `ChooseValueChoice`, a pilot picks from it, and a seeded sim has to replay
 * identically. Every branch below is either a frozen constant or a scan of
 * `state.battlefield` / a player's zone arrays in array order — no set iteration
 * order and no sort by anything that could tie.
 *
 * An EXPLICIT menu on the card (Cloud Key's "choose artifact, creature,
 * enchantment, instant, or sorcery") always wins: there the card, not the rules,
 * decides what is on offer.
 */
export function asEntersOptions(
  state: GameState,
  choice: AsEntersChoice,
  chooser: PlayerId,
): readonly ChoiceValueOption[] {
  if (choice.options !== undefined) {
    return choice.options.map((value) => ({ value, label: value }));
  }
  switch (choice.subject) {
    case 'color':
      return COLOR_OPTIONS;
    case 'basicLandType':
      return BASIC_LAND_TYPE_OPTIONS;
    case 'player':
      return PLAYER_IDS.map((id) => ({ value: id, label: `player ${id}` }));
    case 'creatureType':
      return creatureTypeOptions(state, chooser);
    case 'cardType':
      // A `cardType` naming with no printed menu has nothing to offer: the
      // subject exists for the cards that print their own list, and inventing
      // "every card type in the game" would put modes on the menu no printed
      // card ever offers. Empty is answered as `NOTHING_CHOSEN`, which matches
      // nothing — the inert default, reached honestly.
      return NO_OPTIONS;
    default:
      return NO_OPTIONS;
  }
}

/** Shared empty menu — no allocation for the degenerate case. */
const NO_OPTIONS: readonly ChoiceValueOption[] = Object.freeze([]);

/**
 * The creature types on offer: every subtype printed on a CREATURE card the
 * chooser owns (in any zone), plus every creature on the battlefield whoever
 * controls it.
 *
 * The chooser's own cards are information they legitimately have — a player
 * knows their decklist — and the battlefield is public. Nothing here reads the
 * OPPONENT's hidden zones, which is the line that matters: the option list
 * travels only to its chooser, but its LENGTH reaches the public `choiceAsked`
 * observation, so a menu built from an opponent's library would leak the shape
 * of a hand nobody has seen.
 *
 * First-appearance order over the battlefield and then the chooser's zones, so
 * the list is stable for a given state.
 */
function creatureTypeOptions(state: GameState, chooser: PlayerId): readonly ChoiceValueOption[] {
  const seen = new Set<string>();
  const out: ChoiceValueOption[] = [];
  const collect = (card: CardInstance): void => {
    if (!card.def.types.includes('creature')) return;
    for (const subtype of card.def.subtypes ?? []) {
      const key = subtype.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: subtype, label: subtype });
    }
  };
  for (const permanent of state.battlefield) collect(permanent);
  const player = state.players[chooser];
  for (const card of player.hand) collect(card);
  for (const card of player.library) collect(card);
  for (const card of player.graveyard) collect(card);
  for (const card of player.exile) collect(card);
  return out;
}

/**
 * The COLOUR this permanent named, or `undefined` when it named nothing (or
 * names something that is not a colour).
 *
 * The guard is not paranoia: `chosenAsEntered` is one string field shared by
 * five subjects, so a colour reader must confirm it is looking at a colour
 * rather than trust the card to be well-formed. A malformed value reads as
 * "nothing named", which is the inert default.
 */
export function chosenColorOf(permanent: ChoiceBearingPermanent): ManaColor | undefined {
  const chosen = permanent.chosenAsEntered;
  if (chosen === undefined || chosen === NOTHING_CHOSEN) return undefined;
  return (CHOOSABLE_COLORS as readonly string[]).includes(chosen) ? (chosen as ManaColor) : undefined;
}

/**
 * The SUBTYPE this permanent named (a creature type, a basic land type), or
 * `undefined` when it named nothing.
 *
 * There is no validation against a list of legal subtypes for the same reason
 * `hasSubtype` does not validate: printed subtypes are open-ended data, and the
 * only wrong answer here is inventing a value where none was named.
 */
export function chosenSubtypeOf(permanent: ChoiceBearingPermanent): string | undefined {
  const chosen = permanent.chosenAsEntered;
  return chosen === undefined || chosen === NOTHING_CHOSEN ? undefined : chosen;
}

/** The named PLAYER, or `undefined` — same shape and same guard as the colour reader. */
export function chosenPlayerOf(permanent: ChoiceBearingPermanent): PlayerId | undefined {
  const chosen = permanent.chosenAsEntered;
  if (chosen === undefined || chosen === NOTHING_CHOSEN) return undefined;
  return (PLAYER_IDS as readonly string[]).includes(chosen) ? (chosen as PlayerId) : undefined;
}

/**
 * Write the named value onto the entering permanent and announce it.
 *
 * The ONE writer, called by both entry paths that can ask — the engine's
 * land-play branch and the `chooseAsEnters` primitive that runs while a
 * permanent spell resolves. Two paths, one function, so the stored form and the
 * announcement can never disagree about what "chose nothing" looks like.
 *
 * Naming NOTHING stores nothing: the field stays absent, which keeps the ordinary
 * instance on the object shape `cloneInstance` copies cheapest, and keeps
 * "nothing chosen" spelled exactly one way for every reader.
 */
export function recordChosenAsEntered(
  permanent: CardInstance,
  choice: AsEntersChoice,
  value: string,
  emit: (event: GameEvent) => void,
): void {
  if (value !== NOTHING_CHOSEN) permanent.chosenAsEntered = value;
  emit({
    type: 'chosenAsEnters',
    instanceId: permanent.instanceId,
    name: permanent.def.name,
    subject: choice.subject,
    value,
    described: describeChosenValue(choice.subject, value),
  });
}

/** A log/UI rendering of a named value ("white", "Goblin", "player B", "nothing"). */
export function describeChosenValue(subject: ChosenValueSubject, value: string): string {
  if (value === NOTHING_CHOSEN) return 'nothing';
  if (subject === 'color') {
    return COLOR_OPTIONS.find((option) => option.value === value)?.label ?? value;
  }
  if (subject === 'player') return `player ${value}`;
  return value;
}
