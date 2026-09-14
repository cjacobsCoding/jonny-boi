/**
 * THE ONLINE BOARD GETS WHAT THE HOTSEAT BOARD GETS (§3.143 wave 2, GAP-20).
 *
 * ## Why this file exists at all
 *
 * Wave 1 shipped UX-1 (a stack of real card faces), UX-2 (the stack always
 * visible) and UX-10 (one hover funnel) with a full green suite — and none of
 * them reached the online board, because the online board was nobody's lane.
 * `StackPanel`, `CardHover` and `CardFace` were all *reused* here already; what
 * was missing was the four props that make them show anything, and no test
 * could see that, because every wave-1 test rendered the component in isolation
 * with good props supplied by hand.
 *
 * **So every assertion below is about REACH, not about shape.** It mounts the
 * REAL `OnlineBoard` on a REAL masked view — the same `maskStateForSeat` the
 * server calls — and asks what a player would actually see. A component that
 * exists, compiles and is imported but is fed `nameOf={() => 'card'}` fails
 * here exactly as loudly as one that was never written.
 *
 * ## The anti-cheat line this file also holds
 *
 * The fixtures are built by masking a real `GameState` for seat A, so the board
 * is handed precisely what the wire carries. The last test asserts that no
 * opponent hand card's NAME appears anywhere in the rendered markup: a prettier
 * stack must never be paid for with hidden information, and "the UI needed a
 * face" is the exact excuse under which that leak would arrive.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { maskStateForSeat, type MaskedGameView } from '@jonny-boi/protocol';
import { SAMPLE_DECKS } from '@jonny-boi/sim';
import { isCreature, type CardInstance, type CombatState, type GameState, type PlayerId } from '@jonny-boi/core';
import { startHotseatGame } from '../../lib/play/setup.js';
import { GameSession } from '../../lib/play/session.js';
import { cardImage, getCard } from '../../lib/cards.js';
import type { GameFrame } from '../../lib/online/online-state.js';
import {
  combatHoldDecision,
  COMBAT_HOLD_KINDS,
  NO_BEATS_SPENT,
  type CombatHold,
} from '../../lib/play/combat-hold.js';
import {
  BOARD_3D_CONFIG,
  BOARD_LAYOUT_CONFIG,
  COMBAT_HOLD_CONFIG,
} from '../../lib/play/play-config.js';
import { buildBoardView } from '../../lib/play/view-model.js';
import { maskedViewToBoardView } from '../../lib/online/board-adapter.js';
import { stageEntriesFor } from '../play/BoardScene.js';
import type { StageEntry } from '../play/CombatStage.js';
import { PlayBoard } from '../play/PlayBoard.js';
import { AUTO_ADVANCING_HINT, OnlineBoard } from './OnlineBoard.js';

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Alice', B: 'Bob' };

/**
 * The suite runs in Node (the root vitest config installs no DOM), and
 * `usePrefersReducedMotion` (`components/play/AnimationLayer.tsx`, consumed by
 * `CombatLines`) reads `window.matchMedia` DURING RENDER behind a
 * `typeof window.matchMedia` guard — which still throws when `window` itself is
 * undefined. The narrowest possible stand-in, so that this file tests the board
 * rather than the absence of a browser. The real fix is one `typeof window !==
 * 'undefined' &&` in that hook, and it is filed as a contract for its owning
 * lane rather than reached across a lane boundary here.
 */
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
afterAll(() => vi.unstubAllGlobals());

/** A real, legal game — the unmasked truth every fixture below is built from. */
function startedState(): GameState {
  const deck = SAMPLE_DECKS.find((d) => d.name.toLowerCase().includes('red')) ?? SAMPLE_DECKS[0]!;
  const started = startHotseatGame({
    choiceA: { source: 'sample', deck },
    choiceB: { source: 'sample', deck },
    seed: 12345,
    startingPlayer: 'A',
  });
  if (!started.ok) throw new Error('the sample decks must be legal for this fixture');
  return started.game.created.state;
}

/** A real, legal game, masked for seat A exactly as the server would mask it. */
function maskedForA(): MaskedGameView {
  return maskStateForSeat(startedState(), 'A');
}

/**
 * Two of the viewer's own cards that the app can actually draw.
 *
 * Derived from the pool rather than named here: a hard-coded card name is a
 * fixture that rots the day the sample deck changes, and this test's claim
 * ("a stack object shows a real face") needs any drawable card, not a
 * particular one.
 */
function twoDrawableCards(masked: MaskedGameView): readonly [CardInstance, CardInstance] {
  const drawable = (masked.players.A.hand ?? []).filter((c) => {
    const record = getCard(c.def.id);
    return record !== undefined && cardImage(record, 'large') !== undefined;
  });
  const [first, second] = drawable;
  if (first === undefined || second === undefined) {
    throw new Error('the opening hand must contain two cards with Scryfall art for this fixture');
  }
  return [first, second];
}

/**
 * A frame whose stack holds one spell aimed at one battlefield permanent.
 *
 * `controller` is a parameter because "whose spell is this?" is the first fact
 * a player needs when something they did not cast appears (UX-16 leans on the
 * same panel), and the board can only mark it if it is told who is looking.
 */
function frameWithStackedSpell(controller: PlayerId): {
  readonly frame: GameFrame;
  readonly spell: CardInstance;
  readonly target: CardInstance;
} {
  const masked = maskedForA();
  const [spell, target] = twoDrawableCards(masked);
  const view: MaskedGameView = {
    ...masked,
    battlefield: [target],
    stack: [
      {
        kind: 'spell',
        instanceId: spell.instanceId,
        card: spell,
        controller,
        resolvesTo: 'graveyard',
        targets: [target.instanceId],
      },
    ],
  };
  return {
    frame: { view, legalActions: [], yourTurn: false, log: [], events: [] },
    spell,
    target,
  };
}

function render(frame: GameFrame): string {
  return renderToStaticMarkup(
    createElement(OnlineBoard, { frame, names: NAMES, onAction: () => {}, onConcede: () => {} }),
  );
}

/** Just the stack panel's markup — so "there is an image" cannot be satisfied by the hand. */
function stackMarkup(html: string): string {
  const start = html.indexOf('<aside class="stack-panel');
  expect(start, 'the stack panel did not render at all').toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</aside>', start);
  return html.slice(start, end);
}

describe('UX-1 — the ONLINE stack shows real cards, not the word "card"', () => {
  it('every stack row draws a real Scryfall face', () => {
    const { frame, spell } = frameWithStackedSpell('A');
    const stack = stackMarkup(render(frame));
    // THE regression. Before wave 2 this board passed no `faceOf` and the rows
    // fell through to the named placeholder plate, so this count was 0.
    const images = stack.match(/<img\b[^>]*>/g) ?? [];
    expect(images.length, 'the stack row rendered no card image').toBeGreaterThan(0);
    const record = getCard(spell.def.id)!;
    expect(stack).toContain(cardImage(record, 'large')!);
    expect(stack).toContain(spell.def.name);
  });

  it('a targeted row names the real target — not the "card" placeholder', () => {
    const { frame, target } = frameWithStackedSpell('A');
    const stack = stackMarkup(render(frame));
    expect(stack).toContain(target.def.name);
    // `nameOf={() => 'card'}` rendered this exact text node on every target row.
    expect(stack).not.toMatch(/>\s*card\s*</);
  });

  it("an opponent's spell is MARKED as theirs — the board says who is looking", () => {
    const mine = stackMarkup(render(frameWithStackedSpell('A').frame));
    expect(mine).not.toContain('stack-row--opponents');
    const theirs = stackMarkup(render(frameWithStackedSpell('B').frame));
    // Only possible because the mount site passes `viewer`; without it the panel
    // honestly marks nothing (see `StackRowContext.viewer`).
    expect(theirs).toContain('stack-row--opponents');
  });

  it('UX-2 — the stack floats over the board instead of sharing the log column', () => {
    const stack = stackMarkup(render(frameWithStackedSpell('A').frame));
    expect(stack).toContain('stack-panel--floating');
    expect(stack).not.toContain('stack-panel--column');
  });
});

describe('UX-10 — the online hand goes through the ONE hover funnel', () => {
  it('each hand slot wraps its card in a hover anchor', () => {
    const html = render(frameWithStackedSpell('A').frame);
    // `CardHover` with no className renders a bare <span> around its children;
    // that span between the slot and the card IS the funnel. Matching it
    // positionally is the point — remove the wrapper and this line reddens.
    expect(html).toMatch(/<div class="hand-card-slot[^"]*"[^>]*><span><(?:div|button) class="play-card/);
  });

  it('the hand card itself draws a real face (the shared renderer reached it)', () => {
    const { frame } = frameWithStackedSpell('A');
    const html = render(frame);
    const hand = html.slice(html.indexOf('hand-card-slot'));
    expect(hand).toMatch(/<img\b[^>]*src="https:\/\//);
  });
});

describe('the parity work never widened what a viewer may see', () => {
  it("no opponent hand card's name appears anywhere in the rendered board", () => {
    const masked = maskedForA();
    const started = startHotseatGame({
      choiceA: { source: 'sample', deck: SAMPLE_DECKS[0]! },
      choiceB: { source: 'sample', deck: SAMPLE_DECKS[0]! },
      seed: 12345,
      startingPlayer: 'A',
    });
    if (!started.ok) throw new Error('fixture');
    // The UNMASKED state is the only place seat B's hand exists; the board is
    // handed the MASKED one, and must render nothing that only the unmasked
    // view knows. (Both decks are the same list, so a name shared with the
    // viewer's own visible cards is excluded — this asks about identities the
    // viewer could ONLY have learned from B's hand.)
    const hidden = started.game.created.state.players.B.hand;
    const visible = new Set<string>([
      ...(masked.players.A.hand ?? []).map((c) => c.def.name),
      ...masked.battlefield.map((c) => c.def.name),
      ...masked.players.A.graveyard.map((c) => c.def.name),
      ...masked.players.B.graveyard.map((c) => c.def.name),
    ]);
    const html = render({ view: masked, legalActions: [], yourTurn: false, log: [], events: [] });
    for (const card of hidden) {
      if (visible.has(card.def.name)) continue;
      expect(html, `${card.def.name} is in B's hand and must not be on A's screen`).not.toContain(
        card.def.name,
      );
    }
  });
});

/**
 * §10 — THE ONLINE BOARD HOLDS COMBAT ON SCREEN TOO.
 *
 * ## The defect these assertions remove
 *
 * The hotseat board measured it: 260 ms after "Confirm 1 block", sampled
 * without passing priority, the board read `blocking=0 staged=0 arcs=0 | Turn 7
 * · Main Phase 1`. Blocks, combat damage and end-of-combat had all resolved and
 * the turn had advanced. The hotseat fix shipped and said out loud that the
 * ONLINE board was not covered: it has its own advance path (`shouldAutoPass`
 * plus the auto-pass effect) and got no hold, so the same combat was equally
 * invisible to anyone playing online.
 *
 * ## Why the fixture is a real MASK and not a hand-built prop
 *
 * Same standard as the rest of this file: a real `GameState` driven into a real
 * blocked combat, then `maskStateForSeat`, so the board is handed exactly what
 * the wire carries. A board that "supports" a hold but never sees a combat
 * state it recognises fails here as loudly as one that was never written.
 *
 * ## ⚠️ WHAT STATIC MARKUP CAN AND CANNOT SETTLE
 *
 * It cannot prove a state LASTED long enough to read — that is what
 * `apps/web/scripts/verify-combat-visibility.mjs` is for on the hotseat side.
 * What it CAN settle is the half that is a pure function of the frame: the
 * board announces the beat, paints the block, and — the load-bearing one — does
 * NOT claim to be advancing while the beat is owed. That last assertion is
 * two-sided on purpose: the control frame (no blocks declared) must SAY
 * "advancing…", or the held frame's silence would prove nothing, which is the
 * exact trap §10 records ("the first version of that assertion passed without
 * the fix").
 */

/** The seat letters this fixture uses: the OPPONENT attacks, the VIEWER blocks. */
const ATTACKING_SEAT: PlayerId = 'B';
const BLOCKING_SEAT: PlayerId = 'A';

/** The first creature in a seat's opening hand — any creature, never a named one. */
function firstCreature(hand: readonly CardInstance[], seat: PlayerId): CardInstance {
  const found = hand.find((c) => isCreature(c.def));
  if (found === undefined) throw new Error(`seat ${seat}'s opening hand must contain a creature`);
  return found;
}

/**
 * A real blocked combat, masked for the blocking seat.
 *
 * `blockersDeclared: false` gives the CONTROL: the identical window one beat
 * earlier, where nothing is owed and the board is supposed to advance. Every
 * other input is held equal, so the only thing the two frames disagree about is
 * whether a beat is owed.
 */
function blockedCombat({ blockersDeclared }: { blockersDeclared: boolean }): {
  readonly state: GameState;
  readonly attacker: CardInstance;
  readonly blocker: CardInstance;
} {
  const base = startedState();
  const attacker = firstCreature(base.players[ATTACKING_SEAT].hand, ATTACKING_SEAT);
  const blocker = firstCreature(base.players[BLOCKING_SEAT].hand, BLOCKING_SEAT);
  const combat: CombatState = {
    attackers: [attacker.instanceId],
    blocks: blockersDeclared ? { [blocker.instanceId]: attacker.instanceId } : {},
    attackersDeclared: true,
    blockersDeclared,
  };
  const state: GameState = {
    ...base,
    activePlayer: ATTACKING_SEAT,
    priorityPlayer: BLOCKING_SEAT,
    step: 'declareBlockers',
    combat,
    battlefield: [
      { ...attacker, controller: ATTACKING_SEAT },
      { ...blocker, controller: BLOCKING_SEAT },
    ],
    // The blocking seat's hand is emptied so NOTHING is castable or
    // tap-castable: `shouldAutoPass` stops for either, and a window it would
    // have stopped in anyway could not tell us whether the hold did the work.
    players: {
      ...base.players,
      [BLOCKING_SEAT]: { ...base.players[BLOCKING_SEAT], hand: [] },
    },
  };
  return { state, attacker, blocker };
}

function blockedCombatFrame({ blockersDeclared }: { blockersDeclared: boolean }): GameFrame {
  const inCombat = blockedCombat({ blockersDeclared }).state;
  return {
    view: maskStateForSeat(inCombat, BLOCKING_SEAT),
    // Passing is the ONLY thing on offer — the auto-pass window, exactly the one
    // that walked the §10 measurement into the next turn.
    legalActions: [{ kind: 'passPriority', player: BLOCKING_SEAT }],
    yourTurn: true,
    log: [],
    // No damage has been dealt in this window yet — it is the BLOCK step.
    events: [],
  };
}

describe('§10 — the ONLINE board holds combat on screen', () => {
  it('announces the beat, worded from the shared KIND table', () => {
    const html = render(blockedCombatFrame({ blockersDeclared: true }));
    const row = COMBAT_HOLD_KINDS.blocksDeclared;
    expect(html).toContain('combat-hold combat-hold--blocksDeclared');
    // From the ROW, not re-worded here — a banner that invented its own words
    // would satisfy a hard-coded string and still be a second answer.
    expect(html).toContain(row.label);
    expect(html).toContain(row.shows);
    // The way out. A beat nobody can skip is a tax on every combat.
    expect(html).toContain('combat-hold__skip');
  });

  it('paints the blocker AS blocking — the picture the beat exists to show', () => {
    const html = render(blockedCombatFrame({ blockersDeclared: true }));
    expect(html).toContain('perm--blocking');
    expect(html).toContain('aria-label="Blocking"');
  });

  it('STOPS this board advancing under the beat — and the control proves it', () => {
    const held = render(blockedCombatFrame({ blockersDeclared: true }));
    const walking = render(blockedCombatFrame({ blockersDeclared: false }));
    // The control: the same seat, the same single legal action, no beat owed —
    // so the board really is in an auto-pass window and really does say so.
    expect(walking).toContain(AUTO_ADVANCING_HINT);
    expect(walking).not.toContain('combat-hold--');
    // …which makes THIS the gate and nothing else. Delete the `combatHold !==
    // null` argument to `shouldAutoPassNow` in `OnlineBoard.tsx` and this line
    // is the one that reddens.
    expect(held).not.toContain(AUTO_ADVANCING_HINT);
  });
});

/**
 * THE TWO BOARDS MUST NOT DRIFT APART (CLAUDE.md rule 12).
 *
 * The hold DECISION is already one module both boards read. What a second copy
 * could still drift in is the two things the decision does not own: the strip
 * that announces the beat, and the fact that each board's own advance path
 * actually asks. Those advance paths are genuinely different shapes — a
 * synchronous local priority walk versus a server frame stream — so this is the
 * "second copy is unavoidable: derive both from one source and add a test that
 * fails when they diverge" case, and this is that test.
 */
describe('the combat hold reaches BOTH boards, identically', () => {
  /** Read a source file newline-agnostically (CLAUDE.md's CRLF trap). */
  function source(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
  }

  /** Just the announce strip, from either board's markup. */
  function holdBanner(html: string): string {
    const start = html.indexOf('<div class="combat-hold ');
    expect(start, 'this board rendered no combat-hold banner at all').toBeGreaterThanOrEqual(0);
    const end = html.indexOf('</div>', start);
    return html.slice(start, end + '</div>'.length);
  }

  /** The beat both boards are asked to announce — from the ONE decision funnel. */
  function beat(): CombatHold {
    const decision = combatHoldDecision(
      {
        step: 'declareBlockers',
        combat: { blockersDeclared: true, attackerCount: 1, blockCount: 1 },
        spent: NO_BEATS_SPENT,
        reducedMotion: false,
        gameOver: false,
      },
      COMBAT_HOLD_CONFIG,
    );
    if (decision.kind !== 'hold') throw new Error(`a declared block must hold: ${decision.detail}`);
    return decision.hold;
  }

  it('renders the SAME strip on the hotseat board and the online board', () => {
    const deck = SAMPLE_DECKS[0]!;
    const started = startHotseatGame({
      choiceA: { source: 'sample', deck },
      choiceB: { source: 'sample', deck },
      seed: 4242,
      startingPlayer: 'A',
    });
    if (!started.ok) throw new Error('the sample deck must be legal for this fixture');
    const hotseat = renderToStaticMarkup(
      createElement(PlayBoard, {
        session: GameSession.fromCreated(started.game.created, started.game.registry, NAMES),
        viewer: 'A',
        onSubmit: () => {},
        onConcede: () => {},
        stops: { fullControl: false },
        onStops: () => {},
        combatHold: beat(),
        onCombatHoldSkip: () => {},
      } as never),
    );
    // Byte-identical: same component, same row, same Skip. A re-wording or a
    // restyle on one board can no longer land without the other.
    expect(holdBanner(render(blockedCombatFrame({ blockersDeclared: true })))).toBe(
      holdBanner(hotseat),
    );
  });

  it("each board's OWN advance path asks the hold before it moves", () => {
    // The hotseat's walk is stopped from INSIDE its stop predicate, because
    // `autoAdvancePriority` walks many windows in one call and a gate outside
    // the loop cannot stop it partway (§10's measurement is that failure).
    expect(source('../../views/PlayView.tsx')).toContain("combatHoldFor(candidate).kind === 'hold'");
    // The online board's analogue is the composed funnel, whose second argument
    // is required — so the board cannot ask the rules question without also
    // answering the hold one.
    const online = source('./OnlineBoard.tsx');
    expect(online).toContain('shouldAutoPassNow(');
    expect(online).toContain('combatHold !== null,');
    // …and there is no ungated path left for it to fall back to.
    expect(online).not.toMatch(/[^w]shouldAutoPass\(/);
  });
});

/**
 * THE SCENE IS ONE UNIT, AND THIS IS THE TEST THAT FAILS WHEN IT FORKS AGAIN.
 *
 * ## The defect class
 *
 * `PlayBoard` and `OnlineBoard` each answered "how do I draw a battlefield
 * during combat?", and answered it differently. The LEAVES were never the
 * problem — this board already imported eleven components from `play/`. What was
 * never extracted was the SCENE COMPOSITION, and so UX-9 (the tilt), UX-12 (the
 * advance and its midline clamp), UX-13 (the blocker advance) and UX-14 (the
 * attack arcs) shipped to the hotseat board alone, four separate times, each one
 * looking like a feature rather than like the fork it was.
 *
 * `BoardScene` is the one unit. These assertions are what makes a SECOND copy
 * fail loudly instead of quietly: both boards are rendered from the SAME real
 * blocked combat — the online one through `maskStateForSeat`, exactly what the
 * wire carries — and their scene skeletons are compared element for element.
 *
 * ## ⚠️ WHAT STATIC MARKUP CAN AND CANNOT SETTLE (the same limit §10 records)
 *
 * `CombatStage` measures the DOM and returns `null` under `renderToStaticMarkup`
 * — deliberately, and one test below pins that, because a stage that rendered
 * server-side would be placing cards from rects it never measured. So the
 * ADVANCE ITSELF cannot be observed in markup. What can: the pure rule that
 * decides which cards walk out, asked with each board's own view model. If those
 * two agree, the boards cannot disagree about the advance; if they ever stop
 * agreeing, this is the line that reddens.
 */
describe('BOTH boards draw the same scene — the fork cannot come back quietly', () => {
  /** The scene's skeleton: the classes that ARE the composition, in DOM order. */
  const SCENE_SKELETON = [
    'board-stage',
    'board-scene',
    'board-scene__table',
    'play-board__opponent',
    'play-hand--hidden',
    'board-midline',
    'play-board__self',
    'drop-zone',
    'board-rail',
  ] as const;

  /**
   * Every skeleton class the markup emits, in the order it emits them.
   *
   * A WHITELIST, so the seats' different contents (different cards, different
   * counts) cannot make two identical scenes look different — and so a missing
   * midline or a rail that never rendered cannot hide inside a diff of card art.
   */
  function skeletonOf(html: string): string[] {
    const found: string[] = [];
    for (const match of html.matchAll(/class="([^"]*)"/g)) {
      const tokens = (match[1] ?? '').split(/\s+/);
      for (const want of SCENE_SKELETON) if (tokens.includes(want)) found.push(want);
    }
    return found;
  }

  /** The hotseat board, rendered on the SAME `GameState` the online frame masks. */
  function hotseatMarkup(state: GameState): string {
    const deck = SAMPLE_DECKS.find((d) => d.name.toLowerCase().includes('red')) ?? SAMPLE_DECKS[0]!;
    const started = startHotseatGame({
      choiceA: { source: 'sample', deck },
      choiceB: { source: 'sample', deck },
      seed: 12345,
      startingPlayer: 'A',
    });
    if (!started.ok) throw new Error('the sample decks must be legal for this fixture');
    return renderToStaticMarkup(
      createElement(PlayBoard, {
        session: GameSession.fromCreated(
          { state, events: started.game.created.events },
          started.game.registry,
          NAMES,
        ),
        viewer: BLOCKING_SEAT,
        onSubmit: () => {},
        onConcede: () => {},
        stops: { fullControl: false },
        onStops: () => {},
      } as never),
    );
  }

  it('renders a BYTE-IDENTICAL scene skeleton from the same blocked combat', () => {
    const { state } = blockedCombat({ blockersDeclared: true });
    const online = skeletonOf(render(blockedCombatFrame({ blockersDeclared: true })));
    const hotseat = skeletonOf(hotseatMarkup(state));
    // Not "both contain a board-scene somewhere": the same elements, nested the
    // same way, in the same order. Remove the scene from either board — or nest
    // an overlay back inside it — and this is the line that goes red.
    expect(online).toEqual([...SCENE_SKELETON]);
    expect(online).toEqual(hotseat);
  });

  it('UX-9 — both boards hand the CSS the same tabletop numbers', () => {
    const { state } = blockedCombat({ blockersDeclared: true });
    // The properties are inline on `.play-board`, so a board that stopped
    // spreading them shows up here as a missing tilt rather than as a board that
    // merely looks flat in a screenshot nobody took.
    for (const [name, html] of [
      ['online', render(blockedCombatFrame({ blockersDeclared: true }))],
      ['hotseat', hotseatMarkup(state)],
    ] as const) {
      expect(html, `${name} sets no tilt`).toContain(`--board-tilt-deg:${BOARD_3D_CONFIG.tiltDeg}deg`);
      expect(html, `${name} sets no perspective`).toContain(
        `--board-perspective-px:${BOARD_3D_CONFIG.perspectivePx}px`,
      );
      expect(html, `${name} sets no midline thickness`).toContain(
        `--board-midline-h:${BOARD_LAYOUT_CONFIG.midlineThicknessPx}px`,
      );
    }
  });

  it('UX-12/UX-13 — the SAME blocker walks out, from either board’s view model', () => {
    const { state, attacker, blocker } = blockedCombat({ blockersDeclared: true });
    const online = stageEntriesFor(
      maskedViewToBoardView(maskStateForSeat(state, BLOCKING_SEAT), NAMES),
      BLOCKING_SEAT,
    );
    const hotseat = stageEntriesFor(buildBoardView(state, BLOCKING_SEAT, NAMES), BLOCKING_SEAT);

    // The picture the beat exists to show: the attacker forward, and the blocker
    // out to MEET it. `toward` is -1 for the viewer's own seat (up, toward the
    // midline) and +1 for the far one.
    const shape = (entries: readonly StageEntry[]): unknown =>
      entries.map((e) => ({ id: e.perm.instanceId, role: e.role, toward: e.toward, meets: e.meets }));

    expect(shape(online)).toEqual([
      { id: attacker.instanceId, role: 'attacker', toward: 1, meets: undefined },
      { id: blocker.instanceId, role: 'blocker', toward: -1, meets: attacker.instanceId },
    ]);
    // …and the hotseat board's view model must produce exactly the same advance.
    // THE regression: before the extraction the online view model dropped
    // `attackersDeclared` / `blockersDeclared`, so this side came back EMPTY
    // while the hotseat side did not.
    expect(shape(hotseat)).toEqual(shape(online));

    // The CONTROL. One beat earlier nothing has been declared as blocked, so the
    // blocker must stay home — otherwise "the blocker advances" would be
    // satisfied by a rule that advances everything, always.
    const earlier = blockedCombat({ blockersDeclared: false }).state;
    expect(
      stageEntriesFor(
        maskedViewToBoardView(maskStateForSeat(earlier, BLOCKING_SEAT), NAMES),
        BLOCKING_SEAT,
      ).map((e) => e.role),
    ).toEqual(['attacker']);
  });

  it('the stage stays DOM-measured: it renders nothing at all under SSR', () => {
    // Not an incidental fact — an advanced copy is placed from measured rects,
    // and a server-rendered one would be placed from rects that do not exist.
    // Both boards must keep this true; `renderToStaticMarkup` IS the guard.
    const { state } = blockedCombat({ blockersDeclared: true });
    for (const [name, html] of [
      ['online', render(blockedCombatFrame({ blockersDeclared: true }))],
      ['hotseat', hotseatMarkup(state)],
    ] as const) {
      expect(html, `${name} rendered a combat stage without measuring`).not.toContain('combat-stage');
    }
  });

  it('the scene never widened the mask — no hidden card reaches the online scene', () => {
    // The anti-cheat line, re-asked of the SCENE specifically: the attacking
    // seat's hand is hidden, and the scene draws the far seat's hand as BACKS
    // with a count. A scene prop that forced the server to reveal a card would
    // land here.
    const { state } = blockedCombat({ blockersDeclared: true });
    const html = render(blockedCombatFrame({ blockersDeclared: true }));
    const visible = new Set<string>(state.battlefield.map((c) => c.def.name));
    for (const card of state.players[ATTACKING_SEAT].hand) {
      if (visible.has(card.def.name)) continue;
      expect(html, `${card.def.name} is in ${ATTACKING_SEAT}'s hand`).not.toContain(card.def.name);
    }
  });
});
