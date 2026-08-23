import { useMemo, useState, type ReactElement } from 'react';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import type { DecksApi } from '../../lib/useDecks.js';
import { deckSize } from '../../lib/deck.js';
import { HOTSEAT_CONFIG } from '../../lib/play/play-config.js';
import {
  validateChoice,
  type DeckChoice,
} from '../../lib/play/setup.js';

/** A flat option list combining the user's saved decks and the bundled samples. */
interface DeckMenuItem {
  readonly key: string;
  readonly label: string;
  readonly choice: DeckChoice;
}

function buildMenu(decks: DecksApi): DeckMenuItem[] {
  const saved: DeckMenuItem[] = decks.decks
    .filter((d) => deckSize(d) > 0)
    .map((d) => ({ key: `saved:${d.id}`, label: `${d.name} · ${deckSize(d)} cards (yours)`, choice: { source: 'saved', deck: d } }));
  const samples: DeckMenuItem[] = SAMPLE_DECKS.map((d) => ({
    key: `sample:${d.name}`,
    label: `${d.name} · sample`,
    choice: { source: 'sample', deck: d },
  }));
  return [...saved, ...samples];
}

/**
 * The pre-game setup: each player names themselves and picks a deck (their saved
 * decks + the six sample gauntlet decks), plus an optional seed. Both decks are
 * validated against the curated pool; an illegal pick shows a friendly message and
 * the Start button stays disabled until both are legal.
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
    startingPlayer: 'A' | 'B';
  }) => void;
}): ReactElement {
  const menu = useMemo(() => buildMenu(decks), [decks]);

  const [nameA, setNameA] = useState(aiSeat === 'A' ? HOTSEAT_CONFIG.defaultAiName : HOTSEAT_CONFIG.defaultNameA);
  const [nameB, setNameB] = useState(aiSeat === 'B' ? HOTSEAT_CONFIG.defaultAiName : HOTSEAT_CONFIG.defaultNameB);
  const [keyA, setKeyA] = useState(menu[0]?.key ?? '');
  const [keyB, setKeyB] = useState(menu[1]?.key ?? menu[0]?.key ?? '');
  const [seedText, setSeedText] = useState(String(HOTSEAT_CONFIG.defaultSeed));
  const [starter, setStarter] = useState<'A' | 'B'>('A');

  const choiceA = menu.find((m) => m.key === keyA)?.choice;
  const choiceB = menu.find((m) => m.key === keyB)?.choice;

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
                  {menu.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
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
          <select className="select" value={starter} onChange={(e) => setStarter(e.target.value as 'A' | 'B')} aria-label="Who goes first">
            <option value="A">{nameA || 'Player 1'}</option>
            <option value="B">{nameB || 'Player 2'}</option>
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
            startingPlayer: starter,
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
