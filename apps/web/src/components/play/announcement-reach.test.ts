/**
 * THE REACH GUARD for the two 2026-09-14 reports — "built, tested and seen by
 * nobody" is the defect this branch keeps shipping (§7.3 of
 * `docs/MTGA-UX-OVERHAUL.md`, seven instances and counting).
 *
 * Two reports, one mechanism:
 *
 *  - *"it should show that choice being made so the player understands what has
 *    happened"* — a choice the engine settled without asking.
 *  - *"When the computer plays Doom Blade when Im playing them, it does not show
 *    me clearly what the target is … it should show their target(s) for things
 *    along with the card they are casting."*
 *
 * `forced-choice.test.ts` proves the MODEL is right. Nothing there can prove a
 * player ever sees it — which is exactly how `provenance-view.ts` shipped fully
 * tested with no `explanation` prop on the mount. So this file asserts REACH,
 * and it asserts the CLASS: §7.3's own conclusion is that *"the guards that
 * actually work all derive the list of MOUNTS from the source and fail when a
 * new mount appears without the prop"*.
 *
 * A SOURCE test, because "who renders whom, and with which prop" is a
 * relationship between declarations and this board has no render harness.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  DEFAULT_RULES,
  defaultAnswerFor,
  type CardDefinition,
  type GameAction,
  type GameState,
  type InstanceId,
  type PlayerId,
} from '@jonny-boi/core';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import { stackEntries, targetView } from '../../lib/play/stack-view.js';

const here = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** A file with every comment stripped — what the code actually DOES. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const playBoard = code(here('PlayBoard.tsx'));
const playView = code(
  readFileSync(fileURLToPath(new URL('../../views/PlayView.tsx', import.meta.url)), 'utf8').replace(
    /\r\n/g,
    '\n',
  ),
);

// ---------------------------------------------------------------------------
describe('the forced-choice announcement REACHES a screen', () => {
  it('PlayBoard mounts the banner, with the choice AND the cards it picked', () => {
    expect(playBoard).toContain("import { ForcedChoiceBanner } from './ForcedChoiceBanner.js'");
    expect(playBoard, 'the banner is rendered, not merely imported').toMatch(/<ForcedChoiceBanner\b/);
    // Both props: a banner with no `chosen` is the name-string-only version the
    // report explicitly rejects.
    // It is drawn from the ANNOUNCEMENT BODY — the queue's own entry — rather
    // than from a `forcedChoice` prop, because four independent announcers were
    // painting over each other and now go through one surface.
    expect(playBoard).toMatch(/<ForcedChoiceBanner[\s\S]{0,200}forced=\{body\.forced\}/);
    expect(playBoard).toMatch(/<ForcedChoiceBanner[\s\S]{0,200}chosen=\{forcedChoiceTargets\}/);
    // …and it reaches the screen through the ONE surface, never on its own.
    expect(playBoard, 'the banner is a renderer of the surface').toMatch(
      /announcementRenderers[\s\S]{0,2400}forcedChoice: \(body\) => \([\s\S]{0,60}<ForcedChoiceBanner/,
    );
    expect(playBoard).toMatch(
      /<AnnouncementSurface[\s\S]{0,160}renderers=\{announcementRenderers\}/,
    );
  });

  it('the cards it picked are resolved through the SHARED funnel, not a local one', () => {
    expect(playBoard, 'PlayBoard resolves refs with stack-view’s targetView').toMatch(
      /forcedChoiceTargets[\s\S]{0,300}targetView\(ref, referenceCtx\)/,
    );
  });

  it('PlayView really produces one: the event is read and the decision is asked', () => {
    expect(playView).toContain('forcedChoiceOf(');
    expect(playView).toContain('forcedChoiceDecision(');
    expect(playView).toContain('setForcedChoice(candidate)');
    // It is handed down INSIDE the queue now — one prop carrying every
    // announcement, so the board cannot be given one and not another.
    expect(playView, 'and it is handed back down to the board').toMatch(
      /announcements=\{announcements\}/,
    );
    expect(playView, 'as a body of the queue').toMatch(/kind: 'forcedChoice', forced: forcedChoice/);
  });

  /**
   * §10's lesson, applied. A correct thing that lasts 260 ms has not been
   * delivered: the combat hold measured `staged=0` on every one of 24 frames
   * until it gated BOTH movers. An announcement about a trigger that resolves in
   * the next priority window has exactly that shape.
   */
  /**
   * ⚠️ THE GATE MOVED, AND IT MOVED TO ONE PLACE. It used to be the literal
   * `hold || combatHold || forcedChoice`, written out twice. It is now
   * `announcements.holdsGame` — the queue's own `some(row.holds)` — so the thing
   * stopping the game and the thing on screen are read off ONE value (rule 12).
   * Three kinds still hold, exactly as before; `announcements.test.ts` pins that
   * from the table, and this pins that both movers ask.
   */
  it('it GATES the auto-passer and the AI seat, or it is a caption on a board that moved', () => {
    const gates = [...playView.matchAll(/if \(announcements\.holdsGame\) return;/g)];
    expect(gates, 'both movers are gated on the announcement').toHaveLength(2);
    expect(playView, 'and no hand-rolled gate is left beside it').not.toMatch(
      /if \(hold \|\| combatHold \|\| forcedChoice\)/,
    );
  });

  it('it ANNOUNCES — it must never become a prompt', () => {
    const banner = code(here('ForcedChoiceBanner.tsx'));
    expect(banner).toContain('role="status"');
    // The scar `verify-game-resume.mjs` left: `role="dialog"` on a timed
    // announcement told the harness the game had parked a question.
    expect(banner, 'a timed announcement is not a dialog').not.toContain('role="dialog"');
    expect(banner).toContain('aria-live="polite"');
  });
});

// ---------------------------------------------------------------------------
describe('the opponent’s held spell shows what it is aimed at', () => {
  it('SpellHoldCard takes targets and renders them as CARD FACES', () => {
    // It is its OWN module now — the contract `EffectsPreview.tsx` filed when the
    // spell-hold bench could not draw the real announce card, and the thing that
    // lets BOTH boards hand a spell-hold renderer to the one surface.
    const card = code(here('SpellHoldCard.tsx'));
    expect(card).toMatch(/export function SpellHoldCard\([\s\S]{0,1600}targets,/);
    expect(card, 'rendered through the shared list, at face size').toMatch(
      /<CardReferenceList targets=\{targets\} presentation="face"/,
    );
    expect(playBoard, 'and the mount really passes them').toMatch(
      /<SpellHoldCard[\s\S]{0,800}targets=\{holdTargets\}/,
    );
    expect(playBoard, 'through the one surface').toMatch(
      /announcementRenderers[\s\S]{0,1200}spellHold: \(body\) => \([\s\S]{0,40}<SpellHoldCard/,
    );
  });

  it('the held spell’s targets come from the SAME stack facts the panel renders', () => {
    expect(playBoard).toMatch(
      /holdTargets[\s\S]{0,400}view\.stack\.find\([\s\S]{0,200}targetView\(ref, referenceCtx\)/,
    );
  });

  it('it keeps role="status" — the harness reads role="dialog" as a parked question', () => {
    const card = code(here('SpellHoldCard.tsx'));
    expect(card).toMatch(/className="spell-hold"[\s\S]{0,1600}role="status"/);
    expect(card, 'a timed announcement is not a dialog').not.toContain('role="dialog"');
    // And the surface that now wraps it must not add one either — nor a live
    // region, because a live region inside a live region says it twice.
    const surface = code(here('AnnouncementSurface.tsx'));
    expect(surface).not.toContain('role="dialog"');
    expect(surface, 'the wrapper carries no role of its own').not.toMatch(/\srole="/);
  });

  /**
   * MEASURED 2026-09-14 — and this is a real defect the rig found, not a
   * hypothetical. The hold was announcing a Doom Blade whose log already read
   * "Doom Blade resolves. / Grizzly Bears dies.", so there was no stack object
   * left to name a target from. Two causes, one shape, and both are §10's:
   *
   *  1. the auto-passer's `shouldStop` predicate never asked the spell-hold rule
   *     (only the combat-hold one), and a gate outside `autoAdvancePriority`'s
   *     loop cannot stop it partway;
   *  2. the arming effect booked `announced` immediately, so when the predicate
   *     DID ask, it got `alreadyAnnounced` — the announcement defeating its own
   *     gate. `releaseCombatHold` already writes down why booking belongs on
   *     RELEASE.
   */
  it('the hold gates the walk from INSIDE the stop predicate', () => {
    expect(playView, 'one place the rule is asked').toContain('const spellHoldFor = useCallback(');
    expect(playView, 'and the walker asks it').toMatch(
      /autoAdvancePriority\([\s\S]{0,600}spellHoldFor\(candidate\)\.kind === 'hold'/,
    );
  });

  it('the hold is BOOKED on release, never on arm — or it defeats its own gate', () => {
    const arming = playView.slice(
      playView.indexOf('const decision = spellHoldFor(session);'),
      playView.indexOf('const releaseHold = useCallback('),
    );
    expect(arming.length, 'the arming effect was found').toBeGreaterThan(0);
    expect(arming, 'arming must not book the announcement').not.toContain('announcedRef.current.add');
    expect(playView, 'releasing must').toMatch(
      /const releaseHold = useCallback\([\s\S]{0,900}announcedRef\.current\.add/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('ONE renderer for "what is this pointing at" — the class assertion', () => {
  /**
   * DERIVED from the directory, not listed here: any component that draws a
   * target row must do it through `CardReferences.tsx`. A second hand-rolled
   * `stack-target` block is the parallel-vocabulary bug rule 12 exists to stop,
   * and it is exactly what this file would have caught when `StackTargetRow`
   * lived inside `StackPanel.tsx` and the hold could not reach it.
   */
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const components = readdirSync(dir).filter((f) => f.endsWith('.tsx'));

  it.each(components)('%s draws no target row of its own', (file) => {
    if (file === 'CardReferences.tsx') return; // the one renderer
    const text = code(here(file));
    expect(text, `${file} must not hand-roll a target row`).not.toMatch(/className="stack-target/);
    expect(text, `${file} must not hand-roll the target arrow`).not.toContain('TARGET_ARROW');
  });

  it('and the surfaces that DO show references all mount it', () => {
    for (const file of ['StackPanel.tsx', 'ForcedChoiceBanner.tsx', 'SpellHoldCard.tsx']) {
      expect(code(here(file)), `${file} mounts the shared list`).toContain('<CardReferenceList');
    }
  });
});

// ---------------------------------------------------------------------------
describe('a REAL Doom Blade, cast by the opponent at a real creature', () => {
  const POOL = loadCardPool();
  const registry = buildRegistry();
  const byName = (name: string): CardDefinition => {
    const card = POOL.getByName(name);
    if (!card) throw new Error(`pool missing ${name}`);
    return card;
  };

  function act(state: GameState, action: GameAction): GameState {
    const result = applyAction(state, action, DEFAULT_RULES, registry);
    const rejected = result.events.find((e) => e.type === 'actionRejected');
    if (rejected) throw new Error(`unexpected rejection: ${(rejected as { reason: string }).reason}`);
    return result.state;
  }

  function place(
    state: GameState,
    def: CardDefinition,
    controller: PlayerId,
    zone: 'battlefield' | 'hand',
  ): InstanceId {
    const instanceId = state.nextInstanceId++;
    const card = {
      instanceId,
      def,
      controller,
      owner: controller,
      zone,
      tapped: false,
      summoningSick: false,
      damageMarked: 0,
      markedByDeathtouch: false,
      attachedTo: null,
      counters: {},
    };
    if (zone === 'battlefield') state.battlefield.push(card as never);
    else state.players[controller].hand.push(card as never);
    return instanceId;
  }

  it('the hold can name and FACE the creature it is about to kill', () => {
    const SWAMP = byName('Swamp');
    const { state } = createGame({
      seed: 4242,
      decks: {
        A: { cards: Array.from({ length: 60 }, () => SWAMP) },
        B: { cards: Array.from({ length: 60 }, () => SWAMP) },
      },
      registry,
    });
    let s = state;
    let guard = 0;
    while (s.step !== 'precombatMain' && !s.gameOver && guard++ < 400) {
      const q = s.pendingChoice;
      s = q
        ? act(s, { kind: 'answerChoice', player: q.chooser, choiceId: q.id, answer: defaultAnswerFor(q) })
        : act(s, { kind: 'passPriority', player: s.priorityPlayer });
    }
    s.players[s.priorityPlayer].manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };

    // The OPPONENT of the active player casts the removal at the active
    // player's creature — the reported situation, with the seats that way round.
    const caster: PlayerId = s.priorityPlayer === 'A' ? 'B' : 'A';
    const victimSeat: PlayerId = s.priorityPlayer;
    s.players[caster].manaPool = { W: 9, U: 9, B: 9, R: 9, G: 9, C: 9 };
    const victim = place(s, byName('Grizzly Bears'), victimSeat, 'battlefield');
    const blade = place(s, byName('Doom Blade'), caster, 'hand');
    // The active player passes, so priority reaches the opponent at instant
    // speed — which is when a real Doom Blade is actually cast at you.
    s = act(s, { kind: 'passPriority', player: s.priorityPlayer });
    expect(s.priorityPlayer, 'the opponent now holds priority').toBe(caster);
    s = act(s, { kind: 'castSpell', player: caster, instanceId: blade, targets: [victim] });

    // Exactly what `PlayBoard` does for the hold: the stack facts, then the
    // shared `targetView`.
    const nameOf = (id: InstanceId): string =>
      s.battlefield.find((c) => c.instanceId === id)?.def.name ?? `#${id}`;
    const entries = stackEntries(s.stack, { nameOf, faceOf: () => null });
    const held = entries.find((e) => e.name === 'Doom Blade');
    expect(held, 'the spell really is on the stack').toBeDefined();

    const targets = (held as { targets: readonly (InstanceId | PlayerId)[] }).targets.map((ref) =>
      targetView(ref, {
        playerNames: { A: 'Player 1', B: 'Computer' },
        nameOf,
        faceOf: (id) => s.battlefield.find((c) => c.instanceId === id)?.def.id ?? null,
      }),
    );

    expect(targets, 'the hold has exactly one thing to show').toHaveLength(1);
    expect(targets[0]?.name, 'and it NAMES the creature being killed').toBe('Grizzly Bears');
    expect(targets[0]?.kind).toBe('permanent');
    expect(targets[0]?.cardId, 'with a real face to draw, not a placeholder').toBe(
      byName('Grizzly Bears').id,
    );
  });

  it('a spell with NO targets shows nothing rather than an empty row', () => {
    const entries = stackEntries([], { nameOf: () => 'x', faceOf: () => null });
    expect(entries).toHaveLength(0);
  });
});
