/**
 * THE UX-17 REACH GUARD — a full-size card face must carry its PROVENANCE.
 *
 * The gap this exists to stop coming back, stated exactly: `CardFace` renders
 * the change chips, the live text box and the attribution breakdown **only at
 * `size="full"`** (`SIZE_PRESETS.full.chips === true`; a 96px tile has no room
 * and says so). §3.143 wave 1 shipped exactly two `size="full"` mounts in the
 * whole app — the cast prompt and the held opponent spell — and **both passed a
 * bare `cardId` and no `explanation`**. Core emitted real attributed rows, the
 * view model routed all ten characteristics, `provenance-view.ts` was fully
 * tested, and the type / subtype / name / colour / mana-cost / controller half
 * of Caleb's request rendered ZERO times in the running app.
 *
 * Nothing could see that, because every test in the chain asserted the MODEL.
 * So this one asserts the MOUNTS, and derives them from the source rather than
 * listing them: a new full-size face with no provenance reddens on arrival.
 *
 * It also pins the LAZINESS the overhaul's §2.1 asked for in as many words —
 * *"Attribution is built only when asked for (a separate entry point / lazy
 * field)"* — which wave 1 built eagerly, one `state.continuous` walk per
 * permanent per board view.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { createGame, type CardDefinition, type CardInstance, type GameState, type PlayerId } from '@jonny-boi/core';
import { buildBoardView, explainForFace } from '../../lib/play/view-model.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

/** Every file that may mount a `CardFace`, by the lane that owns it. */
const MOUNTING_FILES = ['./PlayBoard.tsx'] as const;

/**
 * One `<CardFace …/>` mount, sliced out of the source.
 *
 * A regex rather than a parser because the shape being matched is trivially
 * regular (JSX self-closing element, no nested `>` in these props) and a parser
 * here would be a second, unowned source of truth about the board's syntax.
 */
function cardFaceMounts(source: string): readonly string[] {
  return [...source.matchAll(/<CardFace\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

describe('every full-size card face carries its provenance (UX-17)', () => {
  for (const file of MOUNTING_FILES) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const mounts = cardFaceMounts(source);

    it(`${file} mounts card faces at all — otherwise this proves nothing`, () => {
      expect(mounts.length).toBeGreaterThan(0);
    });

    it(`${file} has at least one size="full" mount — the only size that shows chips`, () => {
      const full = mounts.filter((m) => m.includes('size="full"'));
      expect(full.length, 'no full-size face is mounted at all').toBeGreaterThanOrEqual(2);
    });

    it(`${file} passes an explanation at EVERY size="full" mount`, () => {
      for (const mount of mounts) {
        if (!mount.includes('size="full"')) continue;
        expect(
          mount,
          `a full-size CardFace with no explanation — UX-17 renders nothing here:\n${mount}`,
        ).toContain('explanation=');
      }
    });

    it(`${file} sources those explanations from the ONE producer`, () => {
      // Not a hand-rolled `explainCharacteristics` call in the component: the
      // view model owns "what is core's breakdown for this instance?", so a
      // prompt and a tile cannot answer it two different ways (rule 12).
      expect(source).toContain('explainForFace(');
      expect(source, 'the board re-derives provenance itself').not.toContain('explainCharacteristics(');
    });
  }
});

// ---------------------------------------------------------------------------
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst: CardInstance = {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone: 'battlefield',
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
  state.battlefield.push(inst);
  return inst;
}

function boardWith(build: (state: GameState) => void): GameState {
  const forest = card('Forest');
  const created = createGame({
    seed: 7,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => forest) },
      B: { cards: Array.from({ length: 40 }, () => forest) },
    },
    registry,
  });
  const state = created.state;
  state.step = 'precombatMain';
  state.activePlayer = 'A';
  state.priorityPlayer = 'A';
  state.stack = [];
  state.players.A.hand = [];
  state.players.B.hand = [];
  build(state);
  return state;
}

describe('the provenance a tile carries is LAZY (overhaul §2.1)', () => {
  it('`explanation` is a getter, not a value computed for every permanent', () => {
    const state = boardWith((s) => {
      for (let i = 0; i < 5; i += 1) place(s, card('Grizzly Bears'), 'A');
    });
    const view = buildBoardView(state, 'A', SEAT_NAMES);
    expect(view.self.permanents).toHaveLength(5);
    for (const perm of view.self.permanents) {
      const descriptor = Object.getOwnPropertyDescriptor(perm, 'explanation');
      expect(descriptor, 'no `explanation` property at all').toBeDefined();
      // The whole point: eager would be `value`, lazy is `get`.
      expect(typeof descriptor?.get, 'explanation is computed eagerly again').toBe('function');
    }
  });

  it('reading it still answers correctly, and the same object twice (memoised)', () => {
    const state = boardWith((s) => place(s, card('Grizzly Bears'), 'A'));
    const view = buildBoardView(state, 'A', SEAT_NAMES);
    const perm = view.self.permanents[0];
    expect(perm).toBeDefined();
    if (!perm) return;
    const first = perm.explanation;
    expect(first?.name).toBe('Grizzly Bears');
    // One walk per pass, not one per read.
    expect(perm.explanation).toBe(first);
  });
});

describe('explainForFace — the one producer for non-tile faces', () => {
  it('explains a card that is NOT on the battlefield (a spell being cast)', () => {
    let bears!: CardInstance;
    const state = boardWith((s) => {
      bears = place(s, card('Grizzly Bears'), 'A');
    });
    expect(explainForFace(state, bears.instanceId)?.name).toBe('Grizzly Bears');
  });

  it('degrades rather than crashing on an absent or unknown instance', () => {
    const state = boardWith(() => {});
    expect(explainForFace(state, null)).toBeUndefined();
    expect(explainForFace(state, undefined)).toBeUndefined();
    expect(explainForFace(state, 999_999)).toBeUndefined();
  });
});
