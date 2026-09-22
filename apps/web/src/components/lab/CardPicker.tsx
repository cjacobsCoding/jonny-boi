/**
 * THE CARD PICKER — type to filter, with the browser's own filters one click
 * away (DESIGN §3.165), a dwell preview and an approximate search (§3.181).
 *
 * > "Anytime we have a card selector dropdown like this in the app, we must make
 * > it one where you can type to filter, and expose advanced settings to filter
 * > further too - to help you find the one card."
 *
 * > "anywhere that there is a drop down to choose from a list of magic cards in
 * > the whole app, each option in the list must be hoverable to show the
 * > specific card if you pause over an item for a couple seconds without
 * > clicking. Also, all such dropdowns should show a text-typable filter that
 * > optionally allows for fuzzy search if there are more than 10 options in the
 * > list - to make it easier to find what you are looking for."
 *
 * A combobox in the WAI-ARIA sense: a text input that filters a listbox of
 * cards, arrow keys to move, Enter to pick, Escape to close. The filtering,
 * ranking and the two named rules are `lib/lab/cardPicker.ts` (pure, tested);
 * the colour and type chips are the card browser's own vocabulary
 * (`COLOR_FILTERS`, `TYPE_FILTERS`), so a filter here means what it means in the
 * Cards view.
 *
 * ## ⚠️ WHAT THIS COMPONENT'S DOC-COMMENT USED TO CLAIM
 *
 * It said: *"Every selector that picks ONE card from a list of any size goes
 * through this component — the Lab's cut and add pickers today, and whatever
 * comes next."* That was **false of the app** for as long as it was written.
 * `<CardPicker` appeared in exactly ONE component (`SwapPanel`), while three
 * other surfaces picked a card from a list with three separate
 * implementations — the Suggest cut focus (35 bare checkboxes, no filter at
 * all), the deck builder's Add dialog and the scan fixer. The sentence was
 * defensible on a technicality (none of the three picked exactly ONE card from
 * a list) and wrong in the way that matters, and on this repo a doc-comment has
 * already sent an agent to work a headline defect that did not exist. It is
 * corrected here rather than left to mislead again, and `no-raw-card-dropdown`
 * (`scripts/check-card-choosers.mjs`) is the executable version of the claim —
 * prose has now failed this rule twice, so the gate is the rule.
 *
 * ## The dwell preview, and why it is driven by the ACTIVE INDEX
 *
 * Pausing on an option raises the real card after {@link CARD_PREVIEW_DWELL_MS}.
 * It is NOT built by wrapping each option in `CardHover`: this is an
 * `aria-activedescendant` combobox, so DOM focus never leaves the text input and
 * an option receives neither `focus` nor — when the arrow keys move the
 * highlight — `mouseenter`. A hover-wrapped option would have given the feature
 * to people with pointers only.
 *
 * Both inputs already funnel through ONE piece of state, `active`. So the dwell
 * watches `active` and nothing else, which is why the keyboard path cannot
 * silently differ from the mouse path — there is only one path. The panel it
 * raises is `CardPreviewPanel`, the app's single card preview, so there is no
 * second placement calculation and no second card renderer (rule 12).
 *
 * ⚠️ The candidate list is the caller's (the hero's cards for "cut", the whole
 * pool for "add"); this component never decides which cards are pickable. A
 * card the caller lists but the pool cannot describe is still offered, by name.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import type { NormalizedCard } from '@jonny-boi/data-tools';
import { getCard } from '../../lib/cards.js';
import { COLOR_FILTERS, TYPE_FILTERS } from '../../lib/config.js';
import { EMPTY_QUERY, type CardQuery } from '../../lib/filter.js';
import {
  CARD_PREVIEW_DWELL_MS,
  buildFuzzyIndex,
  hasAdvancedFilters,
  listPickableCardsWithin,
  offersFuzzy,
  type CardPickerFilters,
  type ManaValueBounds,
  type PickableCard,
} from '../../lib/lab/cardPicker.js';
import { CardPreviewPanel } from '../CardHover.js';
import { ManaCost } from '../ManaCost.js';
import './card-picker.css';

/**
 * Picking SEVERAL cards instead of one (§3.181).
 *
 * The Suggest panel's two focus controls are multi-selects: "consider cutting
 * these" and "consider bringing in these". Before §3.181 the cut one was a grid
 * of bare checkboxes with no search of any kind, which made it the worst card
 * chooser in the app and the one a user reaches for most often when narrowing a
 * trim. Giving this component a multi mode — rather than giving that grid a
 * filter of its own — is what makes "every card chooser goes through the picker"
 * true instead of aspirational, and it is why the dwell preview and the
 * approximate search arrive on that control for free.
 *
 * Picking does NOT close the list here: ticking six cards must not cost six
 * re-openings.
 */
export interface CardPickerMultiple {
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (cardId: string) => void;
  readonly onClear: () => void;
  /** What the chips are called, e.g. "cutting" -> "Consider cutting: 3 cards". */
  readonly summaryNoun?: string;
}

export interface CardPickerProps {
  /** What the picker is for — the visible label and the accessible name. */
  readonly label: string;
  /** The cards that may be picked. Order is irrelevant; the model ranks. */
  readonly options: readonly PickableCard[];
  /** SINGLE-select: the picked card's id, or `''` for none. */
  readonly value?: string;
  readonly onChange?: (cardId: string) => void;
  /** MULTI-select: pass this instead of `value`/`onChange`. */
  readonly multiple?: CardPickerMultiple;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

function toggle(set: ReadonlySet<string>, code: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  return next;
}

/** A stand-in record for an option the pool cannot describe — offered by name, unfiltered by kind. */
function describedCard(option: PickableCard): NormalizedCard {
  return (
    getCard(option.cardId) ??
    ({
      id: option.cardId,
      name: option.name,
      manaCost: { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, other: [] },
      cmc: 0,
      typeLine: { supertypes: [], types: [], subtypes: [] },
      rawTypeLine: '',
      oracleText: '',
      power: null,
      toughness: null,
      colors: [],
      colorIdentity: [],
      keywords: [],
      set: '',
    } as unknown as NormalizedCard)
  );
}

export function CardPicker({
  label,
  options,
  value,
  onChange,
  multiple,
  disabled,
  placeholder,
}: CardPickerProps): ReactElement {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState<CardQuery>(EMPTY_QUERY);
  const [manaValue, setManaValue] = useState<ManaValueBounds>({});
  const [fuzzy, setFuzzy] = useState(false);
  /**
   * Bumped every time the pointer ENTERS an option, and when it leaves the
   * list. `active` alone is not enough to re-arm the dwell: leaving an option
   * and coming back to the SAME one leaves `active` unchanged, so without this
   * the second pause would never raise a preview — a dead feature that looks
   * alive on the first try.
   */
  const [dwellNonce, setDwellNonce] = useState(0);
  const [preview, setPreview] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const countById = useMemo(() => new Map(options.map((o) => [o.cardId, o.count])), [options]);
  const candidates = useMemo(() => options.map(describedCard), [options]);
  const filters: CardPickerFilters = { query: { ...query, search: text }, manaValue };

  // Caleb's ">10 options" rule, read from the model so the boundary has one home.
  const canFuzzy = offersFuzzy(options.length);
  /**
   * Built over the whole option set and memoised on it, NOT on the typed text:
   * normalising thousands of names on every keystroke is the one way this
   * feature could make the picker feel worse than it did without it.
   */
  const fuzzyIndex = useMemo(
    () => (canFuzzy ? buildFuzzyIndex(candidates) : null),
    [canFuzzy, candidates],
  );
  const fuzzyOn = canFuzzy && fuzzy && fuzzyIndex !== null;

  const listing = useMemo(
    () =>
      listPickableCardsWithin(
        candidates,
        { ...query, search: text },
        manaValue,
        fuzzyOn && fuzzyIndex ? { index: fuzzyIndex } : undefined,
      ),
    [candidates, query, text, manaValue, fuzzyOn, fuzzyIndex],
  );
  /** The first row index that is an APPROXIMATE match, so those rows can say so. */
  const firstFuzzyRow = listing.rows.length - listing.fuzzy;

  const selected = multiple?.selected;
  const picked = options.find((o) => o.cardId === value);
  const chips = useMemo(
    () => (selected ? options.filter((o) => selected.has(o.cardId)) : []),
    [options, selected],
  );

  const clearDwell = useCallback((): void => {
    if (dwellTimer.current !== null) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
  }, []);

  // Close on a click anywhere else — the listbox is not modal.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /**
   * THE DWELL. One timer, watching the highlighted option — see the module
   * header for why this is the active index and not a hover wrapper.
   *
   * The preview is dropped the instant the highlight moves, so running down the
   * list never leaves a stale card on screen, and "leaving before the dwell
   * elapses shows nothing" is a property of the cleanup rather than a second
   * rule that could disagree with the first.
   */
  useEffect(() => {
    clearDwell();
    setPreview(null);
    if (!open || disabled) return undefined;
    const row = listing.rows[active];
    if (!row) return undefined;
    const optionId = `${listId}-${active}`;
    dwellTimer.current = setTimeout(() => {
      // Measured at FIRE time, not at arm time: the list may have scrolled the
      // option under the keyboard while the clock ran.
      const box = document.getElementById(optionId)?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      setPreview({ cardId: row.id, x: box.right, y: box.top });
    }, CARD_PREVIEW_DWELL_MS);
    return clearDwell;
  }, [open, disabled, active, dwellNonce, listing, listId, clearDwell]);

  const dismissPreview = useCallback((): void => {
    clearDwell();
    setPreview(null);
  }, [clearDwell]);

  const pick = (cardId: string): void => {
    // A click is not a pause: whatever the dwell was about to show, the user has
    // answered the question by choosing.
    dismissPreview();
    if (multiple) {
      multiple.onToggle(cardId);
      // Deliberately stays open — see `CardPickerMultiple`.
      return;
    }
    onChange?.(cardId);
    setText('');
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(listing.rows.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      const row = listing.rows[active];
      if (open && row) {
        event.preventDefault();
        pick(row.id);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
      setText('');
      dismissPreview();
    }
  };

  const advanced = hasAdvancedFilters(filters);

  return (
    <div className={`card-picker${open ? ' card-picker--open' : ''}`} ref={rootRef}>
      <label className="card-picker__label section-label" htmlFor={id}>
        {label}
      </label>
      <div className="card-picker__row">
        <input
          id={id}
          className="input card-picker__input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && listing.rows[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={picked ? picked.name : (placeholder ?? 'Type a card name…')}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {canFuzzy && (
          <button
            type="button"
            className={`btn btn--ghost card-picker__fuzzy-toggle${fuzzy ? ' card-picker__fuzzy-toggle--active' : ''}`}
            aria-pressed={fuzzy}
            disabled={disabled}
            onClick={() => {
              setFuzzy((v) => !v);
              setActive(0);
              setOpen(true);
            }}
            title={`Also find close-but-not-exact spellings (${options.length.toLocaleString()} cards in this list)`}
          >
            Fuzzy{fuzzy ? ' •' : ''}
          </button>
        )}
        <button
          type="button"
          className={`btn btn--ghost card-picker__filters-toggle${advanced ? ' card-picker__filters-toggle--active' : ''}`}
          aria-pressed={showFilters}
          disabled={disabled}
          onClick={() => {
            setShowFilters((v) => !v);
            setOpen(true);
          }}
          title="Filter by colour, type and mana value"
        >
          Filters{advanced ? ' •' : ''}
        </button>
      </div>
      {/* Always rendered, so both pickers in a row stay the same height and their
          inputs line up whatever is picked (the popover opens below it). */}
      <div className="card-picker__picked" aria-live="polite">
        {multiple ? (
          chips.length === 0 ? (
            <span className="card-picker__count">
              Nothing picked — {options.length.toLocaleString()} card
              {options.length === 1 ? '' : 's'} to choose from
            </span>
          ) : (
            <>
              {chips.map((chip) => (
                <button
                  key={chip.cardId}
                  type="button"
                  className="chip chip--active card-picker__chip"
                  disabled={disabled}
                  onClick={() => multiple.onToggle(chip.cardId)}
                  title={`Remove ${chip.name}`}
                >
                  {chip.name}
                  {chip.count !== undefined && (
                    <span className="card-picker__count">×{chip.count}</span>
                  )}
                  <span aria-hidden="true"> ×</span>
                </button>
              ))}
              <button
                type="button"
                className="btn btn--ghost card-picker__chip-clear"
                disabled={disabled}
                onClick={multiple.onClear}
              >
                Clear ({chips.length})
              </button>
            </>
          )
        ) : picked ? (
          <>
            <span className="card-picker__picked-name">{picked.name}</span>
            {picked.count !== undefined && (
              <span className="card-picker__count">×{picked.count}</span>
            )}
          </>
        ) : (
          <span className="card-picker__count">
            Nothing picked yet — {options.length.toLocaleString()} card
            {options.length === 1 ? '' : 's'} to choose from
          </span>
        )}
      </div>

      {open && (
        <div className="card-picker__popover">
          {showFilters && (
            <div className="card-picker__filters">
              <div className="filter-group" role="group" aria-label={`${label}: filter by color`}>
                {COLOR_FILTERS.map(({ code, label: colourLabel }) => {
                  const on = query.colors.has(code);
                  return (
                    <button
                      key={code}
                      type="button"
                      className={`chip chip--color chip-color--${code}${on ? ' chip--active' : ''}`}
                      aria-pressed={on}
                      title={colourLabel}
                      onClick={() => setQuery({ ...query, colors: toggle(query.colors, code) })}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>
              <div className="filter-group" role="group" aria-label={`${label}: filter by type`}>
                {TYPE_FILTERS.map((type) => {
                  const on = query.types.has(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      className={`chip${on ? ' chip--active' : ''}`}
                      aria-pressed={on}
                      onClick={() => setQuery({ ...query, types: toggle(query.types, type) })}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
              <div className="card-picker__mv" role="group" aria-label={`${label}: mana value`}>
                <span>Mana value</span>
                <input
                  className="input card-picker__mv-input"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  aria-label="Minimum mana value"
                  placeholder="min"
                  value={manaValue.min ?? ''}
                  onChange={(event) =>
                    setManaValue({
                      ...manaValue,
                      min: event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                />
                <span aria-hidden="true">–</span>
                <input
                  className="input card-picker__mv-input"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  aria-label="Maximum mana value"
                  placeholder="max"
                  value={manaValue.max ?? ''}
                  onChange={(event) =>
                    setManaValue({
                      ...manaValue,
                      max: event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                />
                {advanced && (
                  <button
                    type="button"
                    className="btn btn--ghost card-picker__clear"
                    onClick={() => {
                      setQuery(EMPTY_QUERY);
                      setManaValue({});
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </div>
          )}
          <ul
            id={listId}
            className="card-picker__list"
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple ? true : undefined}
            // The pointer leaving the list ends any pause in progress. The nonce
            // bump is what lets the SAME option re-arm when the pointer returns.
            onMouseLeave={() => {
              dismissPreview();
              setDwellNonce((n) => n + 1);
            }}
          >
            {listing.rows.length === 0 && (
              <li className="card-picker__empty" role="presentation">
                No card matches{text ? ` “${text}”` : ''}
                {advanced ? ' with these filters' : ''}
                {canFuzzy && !fuzzy ? ' — try Fuzzy for close spellings' : ''}.
              </li>
            )}
            {listing.rows.map((card, index) => {
              const count = countById.get(card.id);
              const isPicked = selected ? selected.has(card.id) : card.id === value;
              return (
                <li
                  key={card.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={isPicked}
                  className={`card-picker__option${index === active ? ' card-picker__option--active' : ''}${isPicked ? ' card-picker__option--picked' : ''}${index >= firstFuzzyRow ? ' card-picker__option--fuzzy' : ''}`}
                  onMouseDown={(event) => {
                    // mousedown, not click: the input blurs on click and the
                    // document listener above would close the list first.
                    event.preventDefault();
                    pick(card.id);
                  }}
                  onMouseEnter={() => {
                    setActive(index);
                    setDwellNonce((n) => n + 1);
                  }}
                >
                  {/* The tick and the ≈ marker live INSIDE the name cell on
                      purpose: the option row is a named-area grid, and a new
                      direct child with no `grid-area` is auto-placed — which
                      silently pushes the cost column out of the row. */}
                  <span className="card-picker__option-name">
                    {multiple && (
                      <span className="card-picker__tick" aria-hidden="true">
                        {isPicked ? '☑' : '☐'}
                      </span>
                    )}
                    {card.name}
                    {index >= firstFuzzyRow && (
                      <span className="card-picker__approx" title="an approximate match">
                        {' '}
                        ≈
                      </span>
                    )}
                  </span>
                  {count !== undefined && <span className="card-picker__count">×{count}</span>}
                  <span className="card-picker__option-type">{card.rawTypeLine}</span>
                  <span className="card-picker__option-cost">
                    <ManaCost cost={card.manaCost} />
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="card-picker__footer" aria-live="polite">
            {listing.omitted > 0
              ? `${listing.rows.length} of ${listing.total} shown — keep typing to narrow it down`
              : `${listing.total} card${listing.total === 1 ? '' : 's'}`}
            {listing.fuzzy > 0 && ` · ${listing.fuzzy} approximate`}
          </div>
        </div>
      )}

      {/*
        §3.181 — the dwell preview. Portaled to `<body>` for the same reason
        `CardHover` does it: the popover clips its own overflow, and a card face
        is taller than the dropdown. Pointer-transparent (see card-picker.css)
        so it can never sit between the cursor and the option underneath it —
        this preview is a read, not a surface with its own controls.
      */}
      {preview &&
        createPortal(
          <div className="card-picker-preview">
            <CardPreviewPanel anchor={{ x: preview.x, y: preview.y }} cardId={preview.cardId} name={
              listing.rows.find((r) => r.id === preview.cardId)?.name ??
              options.find((o) => o.cardId === preview.cardId)?.name ??
              ''
            } />
          </div>,
          document.body,
        )}
    </div>
  );
}
