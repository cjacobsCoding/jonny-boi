import type { ReactElement } from 'react';
import type { CharacteristicExplanation, InstanceId, PlayerId } from '@jonny-boi/core';
import type { AbilityOption } from '../../lib/play/session.js';
import { CardHover } from '../CardHover.js';
import { CardFace } from './CardFace.js';
import './ability-prompts.css';

/**
 * THE ACTIVATED-ABILITY PROMPTS — *"which ability of this permanent?"* and
 * *"which target for it?"* — plus the ONE cancel control every pre-commit
 * prompt on either board ends with.
 *
 * Extracted from the hotseat board so the ONLINE board renders the identical
 * prompts: one loyalty-ability UI, not two that drift. Both option lists come
 * exclusively from engine/server offers, so a used-this-turn or unpayable
 * ability is simply absent rather than disabled.
 *
 * ## §3.143 wave 3 — UX-8 REACHES THESE TWO, at last
 *
 * Caleb, verbatim: *"anytime a card is asking me to choose target(s), it should
 * be showing the actual card(s) that is provoking the choice - not just the card
 * name."* Waves 1 and 2 gave that to `ChoicePrompt` and to the board's own cast
 * prompt, and these two — mounted on BOTH boards — were still rendering the
 * source and every candidate as a **bare string in a `.btn`**. No adoption table
 * covered this file, which is exactly how it survived two waves of green tests.
 *
 * The approach is `ChoicePrompt`'s, deliberately not a second one:
 *
 *  - the SOURCE that provoked the question renders its real face at the top;
 *  - every candidate that IS a card renders its real face;
 *  - a candidate with no card to draw — a SEAT ("target player"), a token, a
 *    Scryfall miss — degrades to a NAMED placeholder with the card's footprint,
 *    never a blank rectangle and never silently nothing;
 *  - every face goes through the one {@link CardHover} funnel, so a prompt card
 *    is inspected exactly the way a board card is (UX-10).
 *
 * ## What the boards must supply, and what each absence MEANS
 *
 * These components resolve nothing themselves. `AbilityOption` carries names and
 * ids and no card id at all, and only a board can turn an id into a face without
 * reaching into a zone the viewer may not see — so {@link AbilityPromptFaces}
 * is threaded in. Each member is optional and each absence is a distinct, honest
 * state rather than a guess:
 *
 *  - no `cardIdOf` → every row is a named placeholder (nothing is invented);
 *  - no `explanationOf` → printed truth only, which is the correct answer for a
 *    surface with no continuous-effect index (the online board holds a masked
 *    view and has neither the state nor the index);
 *  - `provenanceUnavailable` says WHY that surface has none, because an empty
 *    breakdown reads as "nothing is modifying this", which is a different claim.
 *
 * ⚠️ There is no per-candidate "blocked" state here, and that is a statement
 * about the data rather than an omission: both lists are built ONLY from actions
 * the engine/server already offered, so an illegal target is ABSENT, not greyed.
 * The reachable "you cannot choose anything" case is an EMPTY list — which now
 * says so in words instead of rendering a dialog with nothing but Cancel in it.
 */

/**
 * How a prompt turns an engine reference into a drawable card. One record, so a
 * board wires the faces ONCE and both prompts read the same answers (rule 12).
 */
export interface AbilityPromptFaces {
  /**
   * This ref's card id, or `null`/`undefined` for something with no card to
   * draw. `null` is a real answer — "there is no face" — never "guess one".
   */
  readonly cardIdOf?: (ref: InstanceId | PlayerId) => string | null | undefined;
  /** Core's live breakdown for this ref, on a surface that has one. */
  readonly explanationOf?: (ref: InstanceId | PlayerId) => CharacteristicExplanation | undefined;
  /** Why this surface carries no provenance at all, when it carries none. */
  readonly provenanceUnavailable?: string;
}

/** The copy for a list the engine offered nothing for, named rather than inlined. */
const NO_ABILITIES_TEXT = 'No ability of this permanent can be activated right now.';
const NO_TARGETS_TEXT = 'Nothing legal to point at.';

/** "Activate which ability of X?" — one row per engine-offered ability. */
export function AbilityMenuPrompt({
  source,
  options,
  faces,
  onChoose,
  onCancel,
  cancelBlocked = null,
}: {
  /** The permanent whose menu this is — its face is drawn at the top (UX-8). */
  source: { readonly instanceId: InstanceId; readonly name: string };
  options: readonly AbilityOption[];
  faces?: AbilityPromptFaces;
  onChoose: (opt: AbilityOption) => void;
  onCancel: () => void;
  /** See {@link ProposalCancelButton}: the honest refusal, or null. */
  cancelBlocked?: string | null;
}): ReactElement {
  return (
    <div className="target-prompt ability-prompt" role="dialog" aria-label="Choose an ability to activate">
      <div className="target-prompt__card ability-prompt__card">
        <PromptHead
          title={`Activate which ability of ${source.name}?`}
          target={source.instanceId}
          name={source.name}
          faces={faces}
        />
        {/*
          The ability LINES stay text, and correctly so: a menu of one
          permanent's abilities drawn as faces would be the same card repeated
          down the dialog. The card the question is ABOUT is drawn once, above,
          which is what UX-8 actually asks for.
        */}
        <div className="target-prompt__options">
          {options.length === 0 ? (
            <p className="ability-prompt__empty">{NO_ABILITIES_TEXT}</p>
          ) : (
            options.map((opt) => (
              <button key={opt.abilityIndex} type="button" className="btn ability-opt" onClick={() => onChoose(opt)}>
                {opt.label}
              </button>
            ))
          )}
        </div>
        <ProposalCancelButton onCancel={onCancel} blocked={cancelBlocked} />
      </div>
    </div>
  );
}

/**
 * The chosen ability's targets — one CARD per engine-offered legal target.
 *
 * `annotateTarget` (optional) is the §3.57 owner/zone note: the boards build it
 * from PUBLIC zones (`makeRefIndex`) so "Mortuary Mire — return which creature
 * card?" says whose graveyard each candidate sits in. The option labels
 * themselves keep coming from the session/server offer; the note only adds.
 */
export function AbilityTargetPrompt({
  ability,
  faces,
  onPick,
  onCancel,
  annotateTarget,
  cancelBlocked = null,
}: {
  ability: AbilityOption;
  faces?: AbilityPromptFaces;
  onPick: (target: InstanceId | PlayerId) => void;
  onCancel: () => void;
  /** Owner/zone note for one target ("yours · graveyard"), or undefined for none. */
  annotateTarget?: (target: InstanceId | PlayerId) => string | undefined;
  /** See {@link ProposalCancelButton}: the honest refusal, or null. */
  cancelBlocked?: string | null;
}): ReactElement {
  const candidates = ability.targets ?? [];
  return (
    <div className="target-prompt ability-prompt" role="dialog" aria-label="Choose a target for the ability">
      <div className="target-prompt__card ability-prompt__card">
        <PromptHead
          title={`${ability.sourceName} — ${ability.label}`}
          subtitle="Choose a target."
          target={ability.instanceId}
          name={ability.sourceName}
          faces={faces}
        />
        {candidates.length === 0 ? (
          <p className="ability-prompt__empty">{NO_TARGETS_TEXT}</p>
        ) : (
          <div className="ability-prompt__cards">
            {candidates.map((choice) => (
              <AbilityCandidate
                key={typeof choice.target === 'string' ? `p:${choice.target}` : `i:${choice.target}`}
                target={choice.target}
                label={choice.label}
                note={annotateTarget?.(choice.target)}
                faces={faces}
                onClick={() => onPick(choice.target)}
              />
            ))}
          </div>
        )}
        <ProposalCancelButton onCancel={onCancel} blocked={cancelBlocked} />
      </div>
    </div>
  );
}

/**
 * §3.143 / UX-4 + UX-5 — THE ONE CANCEL CONTROL, WHICH EXPLAINS ITSELF.
 *
 * Every pre-commit prompt on BOTH boards ends with this, so "can I still back
 * out, and if not why not?" is answered the same way everywhere (rule 12). When
 * the rewind is gone the button does **not** silently vanish and is **not**
 * greyed out without a word: it is replaced by the proposal's own sentence from
 * `REWIND_BLOCK_EXPLANATIONS`, because Caleb's whole complaint is about not
 * understanding what is happening.
 *
 * It lives HERE rather than inside `PlayBoard` because the ability prompts are
 * shared with the online board, and a shared prompt that rolls its own plain
 * Cancel — which is exactly what `AbilityTargetPrompt` did until wave 3 — is a
 * second answer to the same question. The online board has no proposal, so it
 * passes no `blocked` and gets the plain button: one control, two callers.
 */
export function ProposalCancelButton({
  onCancel,
  blocked,
}: {
  onCancel: () => void;
  /** The honest refusal's sentence, or null while cancelling is still legal. */
  blocked: string | null;
}): ReactElement {
  if (blocked !== null) {
    return (
      <span className="target-prompt__blocked" role="status">
        {blocked}
      </span>
    );
  }
  return (
    <button type="button" className="btn btn--ghost" onClick={onCancel}>
      Cancel
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* The shared pieces                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The question, with the card that is asking it beside the words — the same
 * faced header `ChoicePrompt` uses. The face is the thing the player is being
 * asked ABOUT, and the complaint was that it was a name.
 */
function PromptHead({
  title,
  subtitle,
  target,
  name,
  faces,
}: {
  title: string;
  subtitle?: string;
  target: InstanceId | PlayerId;
  name: string;
  faces?: AbilityPromptFaces;
}): ReactElement {
  return (
    <header className="ability-prompt__head">
      <PromptFace target={target} name={name} faces={faces} variant="source" />
      <div className="ability-prompt__headtext">
        <div className="target-prompt__title">{title}</div>
        {subtitle !== undefined && <p className="ability-prompt__sub">{subtitle}</p>}
      </div>
    </header>
  );
}

/**
 * One target, as a card.
 *
 * The whole tile is the button — the same shape the board's cost-payer prompt
 * uses — so the click target is the card the player is looking at rather than a
 * word beside it. The owner/zone note rides underneath (§3.57: "Wall (yours)"
 * vs "Wall (Computer's)"), because a board with two Walls on it makes a list of
 * names unanswerable.
 */
function AbilityCandidate({
  target,
  label,
  note,
  faces,
  onClick,
}: {
  target: InstanceId | PlayerId;
  label: string;
  note?: string;
  faces?: AbilityPromptFaces;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="ability-cand"
      onClick={onClick}
      title={note === undefined ? label : `${label} — ${note}`}
    >
      <PromptFace target={target} name={label} faces={faces} variant="candidate" />
      {note !== undefined && <span className="ability-cand__note">{note}</span>}
    </button>
  );
}

/**
 * A card face for a prompt, or a NAMED placeholder when there is no card to
 * draw. Never an empty box: a seat ("target player") has no card at all, and a
 * token or a Scryfall miss has no art — none of which is a reason to show the
 * player a blank rectangle where the thing they are choosing should be.
 *
 * ⚠️ The placeholder and the face keep the SAME footprint, or the dialog jumps
 * as a list mixes seats with permanents; `ability-prompts.css` gives both the
 * card aspect off one width variable per variant.
 *
 * Exported for the ONE other prompt that lists cards it did not offer as
 * choices — `ComboPrompt` (§3.178) shows the pieces of a found loop — so a
 * prompt card is drawn one way on this board (rule 12), not re-derived there.
 */
export function PromptFace({
  target,
  name,
  faces,
  variant,
}: {
  target: InstanceId | PlayerId;
  name: string;
  faces?: AbilityPromptFaces;
  /** Which of the two sizes this face is drawn at — see the stylesheet. */
  variant: 'source' | 'candidate';
}): ReactElement {
  const cardId = faces?.cardIdOf?.(target) ?? null;
  const explanation = faces?.explanationOf?.(target);
  const unavailable = faces?.provenanceUnavailable;
  const className = `ability-face ability-face--${variant}`;
  if (cardId === null) {
    return (
      <span className={`${className} ability-face--nameonly`} aria-label={name}>
        <span className="ability-face__placeholder">{name}</span>
      </span>
    );
  }
  return (
    <CardHover
      cardId={cardId}
      name={name}
      {...(explanation !== undefined ? { explanation } : {})}
      {...(unavailable !== undefined ? { unavailableReason: unavailable } : {})}
      className={className}
    >
      <CardFace
        size="full"
        cardId={cardId}
        name={name}
        {...(explanation !== undefined ? { explanation } : {})}
        {...(unavailable !== undefined ? { unavailableReason: unavailable } : {})}
      />
    </CardHover>
  );
}
