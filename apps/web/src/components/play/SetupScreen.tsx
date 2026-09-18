import { useMemo, useState, type ReactElement } from 'react';
import type { DecksApi } from '../../lib/useDecks.js';
import { HOTSEAT_CONFIG } from '../../lib/play/play-config.js';
import {
  RANDOM_STARTER,
  resolveStartingPlayer,
  type StarterPreference,
} from '../../lib/play/first-player.js';
import { validateChoice, type DeckChoice } from '../../lib/play/setup.js';
// ONE menu builder for every deck picker — this screen used to keep a private
// copy of it, which is how the two surfaces came to label built-in decks
// differently. See lib/decklist/deckMenu.ts.
import { buildDeckMenu, defaultSeatKeys } from '../../lib/decklist/deckMenu.js';
import { DeckMenuOptions, DeckOriginNote } from '../DeckMenuOptions.js';

/**
 * The pre-game setup: each player names themselves and picks a deck (their saved
 * decks + the six built-in gauntlet decks), plus an optional seed. Both decks are
 * validated against the curated pool; an illegal pick shows a friendly message and
 * the Start button stays disabled until both are legal.
 *
 * The two kinds of deck are GROUPED and labelled rather than listed flat: a
 * built-in deck and your own copy of it used to be adjacent rows differing only
 * by a suffix. Built-ins remain fully selectable — playing one directly is the
 * point of listing them here.
 */
export function SetupScreen({
  decks,
  onStart,
  aiSeat,
}: {
  decks: DecksApi;
  /** In a SOLO game, the seat the computer plays. Absent for pass-and-play. */
  aiSeat?: 'A' | 'B';
  onStart: (args: {
    nameA: string;
    nameB: string;
    choiceA: DeckChoice;
    choiceB: DeckChoice;
    seed: number;
    /** The seat that actually starts — already resolved, never 'random'. */
    startingPlayer: 'A' | 'B';
    /** What the player picked, so a rematch can flip again (§3.63). */
    starterPreference: StarterPreference;
  }) => void;
}): ReactElement {
  const menu = useMemo(() => buildDeckMenu(decks), [decks]);

  const [nameA, setNameA] = useState(aiSeat === 'A' ? HOTSEAT_CONFIG.defaultAiName : HOTSEAT_CONFIG.defaultNameA);
  const [nameB, setNameB] = useState(aiSeat === 'B' ? HOTSEAT_CONFIG.defaultAiName : HOTSEAT_CONFIG.defaultNameB);
  // The first two decks that can actually START, not the first two rows: his own
  // decks lead the menu, and the day a short, unsupported one was seeded second
  // the screen opened with Start disabled. See `defaultSeatKeys`.
  const [initialSeats] = useState(() => defaultSeatKeys(menu));
  const [keyA, setKeyA] = useState(initialSeats.a);
  const [keyB, setKeyB] = useState(initialSeats.b);
  const [seedText, setSeedText] = useState(String(HOTSEAT_CONFIG.defaultSeed));
  const [starter, setStarter] = useState<StarterPreference>('A');

  const itemA = menu.find((m) => m.key === keyA);
  const itemB = menu.find((m) => m.key === keyB);
  const choiceA = itemA?.choice;
  const choiceB = itemB?.choice;

  const problemsA = useMemo(() => (choiceA ? validateChoice(choiceA) : ['Pick a deck.']), [choiceA]);
  const problemsB = useMemo(() => (choiceB ? validateChoice(choiceB) : ['Pick a deck.']), [choiceB]);

  const seed = Number.parseInt(seedText, 10);
  const seedOk = Number.isFinite(seed);
  const canStart = problemsA.length === 0 && problemsB.length === 0 && seedOk && !!choiceA && !!choiceB;

  return (
    <div className="play-setup">
      <h2 className="play-setup__title">{aiSeat ? 'Solo Setup' : 'Pass-and-Play Setup'}</h2>
      <p className="play-setup__intro">
        {aiSeat
          ? 'Pick your deck and the deck the computer plays. Its hand stays hidden, exactly like a human opponent’s.'
          : 'Two players, one device. Pick decks and names, then hand the device back and forth — each player only ever sees their own hand.'}
      </p>

      <div className="play-setup__seats">
        {(['A', 'B'] as const).map((seat) => {
          const isA = seat === 'A';
          const name = isA ? nameA : nameB;
          const setName = isA ? setNameA : setNameB;
          const key = isA ? keyA : keyB;
          const setKey = isA ? setKeyA : setKeyB;
          const problems = isA ? problemsA : problemsB;
          const item = isA ? itemA : itemB;
          const isAi = aiSeat === seat;
          return (
            <div key={seat} className="play-setup__seat">
              <div className="section-label">
                {isAi ? `Computer (seat ${seat})` : `${aiSeat ? 'You' : `Player ${isA ? 'One' : 'Two'}`} (seat ${seat})`}
              </div>
              {/*
                The computer's seat has no name field: naming your opponent is a
                thing you do for a person sitting next to you, and an editable
                "Computer" box is a decision the player did not ask to make.
              */}
              {!isAi && (
                <label className="play-setup__field">
                  <span>Name</span>
                  <input
                    className="input"
                    value={name}
                    maxLength={24}
                    onChange={(e) => setName(e.target.value)}
                    aria-label={`Seat ${seat} name`}
                  />
                </label>
              )}
              <label className="play-setup__field">
                <span>Deck</span>
                <select className="select" value={key} onChange={(e) => setKey(e.target.value)} aria-label={`Seat ${seat} deck`}>
                  {menu.length === 0 && <option value="">No decks available</option>}
                  <DeckMenuOptions menu={menu} />
                </select>
              </label>
              {/* Says what the current pick IS once the dropdown is closed —
                  the collapsed control shows only the label, and the group
                  heading that made it unambiguous is no longer on screen. */}
              <DeckOriginNote origin={item?.origin} />
              {problems.length > 0 && (
                <div className="play-setup__problems" role="alert">
                  <strong>Not ready:</strong>
                  <ul>
                    {problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="play-setup__options">
        <label className="play-setup__field">
          <span>Seed</span>
          <input
            className="input"
            type="number"
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            aria-label="Seed"
            style={{ width: '9rem' }}
          />
        </label>
        <label className="play-setup__field">
          <span>On the play</span>
          <select
            className="select"
            value={starter}
            onChange={(e) => setStarter(e.target.value as StarterPreference)}
            aria-label="Who goes first"
          >
            <option value="A">{nameA || 'Player 1'}</option>
            <option value="B">{nameB || 'Player 2'}</option>
            {/* How the first turn is actually decided at a table (§3.63). The
                flip resolves HERE, to a concrete seat, so the saved game and its
                replay can never disagree about who started. */}
            <option value={RANDOM_STARTER}>Random (flip a coin)</option>
          </select>
        </label>
      </div>

      {!seedOk && <p className="play-setup__problems" role="alert">Enter a whole-number seed.</p>}

      <button
        type="button"
        className="btn btn--primary play-setup__start"
        disabled={!canStart}
        onClick={() =>
          choiceA &&
          choiceB &&
          onStart({
            nameA: name(nameA, HOTSEAT_CONFIG.defaultNameA),
            nameB: name(nameB, HOTSEAT_CONFIG.defaultNameB),
            choiceA,
            choiceB,
            seed,
            // Resolved HERE, so everything downstream — the created game, the
            // saved record, the replay — only ever sees a concrete seat.
            startingPlayer: resolveStartingPlayer(starter),
            // Kept alongside it so a rematch flips again instead of silently
            // repeating this game's winner of the toss.
            starterPreference: starter,
          })
        }
      >
        Start game
      </button>
    </div>
  );
}

/** A trimmed name, falling back to the default when blank. */
function name(value: string, fallback: string): string {
  const t = value.trim();
  return t.length > 0 ? t : fallback;
}
