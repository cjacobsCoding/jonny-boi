/**
 * THE STACK YOU CAN ACTUALLY READ — the guards for UX-1/UX-2 (§3.143).
 *
 * Reported verbatim: *"I cant see whats on the stack at any given moment but I
 * should be able to easily see cards on the stack - and not just card names -
 * just like MTGA."*
 *
 * Every behavioural claim lane A makes is pinned here, and each one is RED
 * without its change:
 *
 *  - a spell draws its OWN card face; an ability draws the face of the permanent
 *    that PRODUCED it (that is the whole "which permanent is triggering?");
 *  - an ACTIVATED ability is not labelled a trigger — core has told the
 *    difference apart since `origin: 'activated'` was added, and the panel used
 *    to throw it away;
 *  - the engine's bottom-first stack is reversed exactly ONCE;
 *  - a stack object with no pool card degrades to a NAMED plate, never a broken
 *    image and never a blank rectangle;
 *  - targets are one relationship per line, not a comma-joined string;
 *  - the fan's geometry comes from `STACK_PANEL_CONFIG` and nowhere else;
 *  - and the two cascade traps the stylesheet depends on stay pinned, because
 *    neither can be seen in a Node test any other way.
 *
 * Plus the DRY guard the two boards need: `stackEntries` and the view-model's
 * own `stackView` must not disagree about what is on the stack or in what
 * order, because they are about to become one function and a silent fork
 * between them would be attributed to neither (rule 12).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  createGame,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type InstanceId,
  type PlayerId,
  type SpellStackObject,
  type TriggeredStackObject,
} from '@jonny-boi/core';
import { StackPanel } from '../../components/play/StackPanel.js';
import { buildBoardView, type StackView } from './view-model.js';
import { STACK_PANEL_CONFIG, CARD_ASPECT_HEIGHT_OVER_WIDTH } from './play-config.js';
import {
  DEFAULT_STACK_PLACEMENT,
  RESOLUTION_LABELS,
  STACK_ENTRY_KINDS,
  STACK_KINDS,
  STACK_PLACEMENTS,
  STACK_PLACEMENT_TABLE,
  STACK_TARGET_KINDS,
  STACK_TARGET_KINDS_TABLE,
  TARGET_ARROW,
  UNSUPPORTED_STACK_KIND,
  resolutionLabel,
  stackEntries,
  stackFaceGeometry,
  stackRows,
  type StackEntry,
  type StackEntryKind,
  type StackRowContext,
} from './stack-view.js';

// -----------------------------------------------------------------------------
// fixtures
// -----------------------------------------------------------------------------

const NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

const FOREST = card('Forest');
const BEARS = card('Grizzly Bears');
const BOLT = card('Lightning Bolt');

function fresh(): GameState {
  return createGame({
    seed: 3,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => FOREST) },
      B: { cards: Array.from({ length: 40 }, () => FOREST) },
    },
    registry,
  }).state;
}

function instance(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  return {
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
}

function place(state: GameState, def: CardDefinition, controller: PlayerId): CardInstance {
  const inst = instance(state, def, controller);
  state.battlefield.push(inst);
  return inst;
}

function spellOn(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  targets: readonly (InstanceId | PlayerId)[] = [],
): SpellStackObject {
  const inst = instance(state, def, controller);
  inst.zone = 'stack';
  const obj: SpellStackObject = {
    kind: 'spell',
    instanceId: inst.instanceId,
    card: inst,
    controller,
    resolvesTo: 'graveyard',
    targets,
  };
  state.stack.push(obj);
  return obj;
}

function abilityOn(
  state: GameState,
  source: CardInstance,
  label: string,
  extra: Partial<TriggeredStackObject> = {},
): TriggeredStackObject {
  const obj: TriggeredStackObject = {
    kind: 'trigger',
    instanceId: state.nextInstanceId++,
    sourceInstanceId: source.instanceId,
    controller: source.controller,
    effects: [],
    targets: [],
    label,
    ...extra,
  };
  state.stack.push(obj);
  return obj;
}

/** The two lookups a real board supplies, built from a state for the tests. */
function sourcesFor(state: GameState): {
  nameOf: (id: InstanceId) => string;
  faceOf: (id: InstanceId) => string | null;
} {
  const find = (id: InstanceId): CardInstance | undefined => {
    const onBf = state.battlefield.find((c) => c.instanceId === id);
    if (onBf) return onBf;
    for (const obj of state.stack) {
      if (obj.kind === 'spell' && obj.instanceId === id) return obj.card;
    }
    return undefined;
  };
  return {
    nameOf: (id) => find(id)?.def.name ?? `#${id}`,
    faceOf: (id) => find(id)?.def.id ?? null,
  };
}

function ctxFor(state: GameState): StackRowContext {
  const s = sourcesFor(state);
  return { playerNames: NAMES, nameOf: s.nameOf, faceOf: s.faceOf };
}

// -----------------------------------------------------------------------------
// the producer: where a face comes from
// -----------------------------------------------------------------------------

describe('stackEntries — the facts about what is on the stack', () => {
  it('a SPELL carries its own card face, and nothing about a source', () => {
    const state = fresh();
    spellOn(state, BOLT, 'A');
    const [entry] = stackEntries(state.stack, sourcesFor(state));
    expect(entry?.kind).toBe('spell');
    expect(entry?.name).toBe(BOLT.name);
    expect(entry?.faceCardId).toBe(BOLT.id);
    expect(entry?.sourceName).toBeNull();
  });

  it('a TRIGGERED ability carries the face and name of the permanent that produced it', () => {
    // The reported need in one assertion: "the player needs to see WHICH
    // permanent is triggering". A row that drew the ability's own (absent) face
    // would be a blank plate labelled with the ability's debug text.
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    abilityOn(state, bears, 'When Grizzly Bears attacks, draw a card.');
    const [entry] = stackEntries(state.stack, sourcesFor(state));
    expect(entry?.kind).toBe('trigger');
    expect(entry?.faceCardId).toBe(BEARS.id);
    expect(entry?.sourceName).toBe(BEARS.name);
    // And the row splits the two apart: the SOURCE is the headline, the
    // ability's own text is the detail underneath it.
    const [row] = stackRows([entry!], ctxFor(state));
    expect(row?.title).toBe(BEARS.name);
    expect(row?.detail).toBe('When Grizzly Bears attacks, draw a card.');
  });

  it('an ACTIVATED ability is labelled as one — core tells them apart, and so does the panel now', () => {
    // RED before this lane: `view-model.stackView` collapses both onto
    // `kind: 'trigger'`, so "{T}: Add {G}" was printed as a *Trigger*. Core has
    // distinguished them since `TriggeredStackObject.origin` was added, because
    // a printed card may name only one of the two.
    const state = fresh();
    const forest = place(state, FOREST, 'A');
    abilityOn(state, forest, '{T}: Add {G}.', { origin: 'activated' });
    const [entry] = stackEntries(state.stack, sourcesFor(state));
    expect(entry?.kind).toBe('activated');
    const [row] = stackRows([entry!], ctxFor(state));
    expect(row?.kindLabel).toBe(STACK_KINDS.activated.label);
    expect(row?.kindLabel).not.toBe(STACK_KINDS.trigger.label);
  });

  it('reverses the engine stack EXACTLY ONCE — the last thing cast resolves first', () => {
    const state = fresh();
    const first = spellOn(state, FOREST, 'A');
    const second = spellOn(state, BOLT, 'B');
    const entries = stackEntries(state.stack, sourcesFor(state));
    expect(entries.map((e) => e.instanceId)).toEqual([second.instanceId, first.instanceId]);
    // …and `stackRows` must NOT reverse again: depth is the index it is given.
    const rows = stackRows(entries, ctxFor(state));
    expect(rows[0]?.instanceId).toBe(second.instanceId);
    expect(rows[0]?.depth).toBe(0);
    expect(rows[0]?.isTop).toBe(true);
    expect(rows[1]?.isTop).toBe(false);
  });

  it('an ability whose source has no pool card keeps its name and asks for no face', () => {
    // A token's ability, and CR 608.2's "the source has left" case. `faceOf`
    // answering `null` is a real answer — the row draws a named plate rather
    // than reaching for the nearest card that happens to exist.
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    abilityOn(state, bears, 'When this creature dies, gain 2 life.');
    const entries = stackEntries(state.stack, {
      nameOf: () => 'Bear Cub Token',
      faceOf: () => null,
    });
    expect(entries[0]?.faceCardId).toBeNull();
    const [row] = stackRows(entries, { playerNames: NAMES, nameOf: () => 'x' });
    expect(row?.faceCardId).toBeNull();
    expect(row?.title).toBe('Bear Cub Token');
    expect(row?.detail).toBe('When this creature dies, gain 2 life.');
  });
});

// -----------------------------------------------------------------------------
// rows: ordering, labels, targets
// -----------------------------------------------------------------------------

describe('stackRows — the rendering decisions', () => {
  it('says when each object resolves, in words, rather than leaving it to be inferred', () => {
    const state = fresh();
    spellOn(state, FOREST, 'A');
    spellOn(state, BOLT, 'B');
    const rows = stackRows(stackEntries(state.stack, sourcesFor(state)), ctxFor(state));
    expect(rows[0]?.resolutionLabel).toBe('Resolves next');
    expect(rows[1]?.resolutionLabel).toBe('2nd to resolve');
  });

  it('the resolution-order table is CLOSED and a deeper stack reports its position honestly', () => {
    for (const [depth, label] of RESOLUTION_LABELS.entries()) {
      expect(resolutionLabel(depth)).toBe(label);
    }
    // Past the table: a number, not an invented ordinal suffix. "#21th" is the
    // kind of near-miss a suffix rule produces, and a wrong word in a tooltip is
    // worse than a plain one.
    expect(resolutionLabel(RESOLUTION_LABELS.length)).toBe(
      `#${RESOLUTION_LABELS.length + 1} to resolve`,
    );
    expect(resolutionLabel(20)).toBe('#21 to resolve');
  });

  it('targets are one RELATIONSHIP each — a permanent, hoverable; a player, named as a seat', () => {
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    spellOn(state, BOLT, 'A', [bears.instanceId, 'B']);
    const [row] = stackRows(stackEntries(state.stack, sourcesFor(state)), ctxFor(state));
    expect(row?.targets).toEqual([
      { kind: 'permanent', ref: bears.instanceId, name: BEARS.name, cardId: BEARS.id },
      { kind: 'player', ref: 'B', name: NAMES.B, cardId: null },
    ]);
  });

  it('without a face lookup, a target is still named — never given a guessed preview', () => {
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    spellOn(state, BOLT, 'A', [bears.instanceId]);
    const entries = stackEntries(state.stack, sourcesFor(state));
    const [row] = stackRows(entries, { playerNames: NAMES, nameOf: () => BEARS.name });
    expect(row?.targets[0]).toEqual({
      kind: 'permanent',
      ref: bears.instanceId,
      name: BEARS.name,
      cardId: null,
    });
  });

  it('a SPELL says what it DOES, not just what it is called', () => {
    // The complaint is "not just card names", and a face drawn at the measured
    // 96px shows art and a name but no legible rules text. An ability already
    // carries its own text; without this a spell would be the one thing on the
    // stack you still had to hover to understand.
    const state = fresh();
    spellOn(state, BOLT, 'A');
    const entries = stackEntries(state.stack, sourcesFor(state));
    const [row] = stackRows(entries, {
      ...ctxFor(state),
      oracleOf: (id) => (id === BOLT.id ? 'Lightning Bolt deals 3 damage to any target.' : null),
    });
    expect(row?.detail).toBe('Lightning Bolt deals 3 damage to any target.');
  });

  it('an EMPTY rules text is an absence, not an empty block', () => {
    // A vanilla creature spell has no text at all. Normalising '' to null means
    // the renderer has ONE absence to handle rather than two.
    const state = fresh();
    spellOn(state, BEARS, 'A');
    const [row] = stackRows(stackEntries(state.stack, sourcesFor(state)), {
      ...ctxFor(state),
      oracleOf: () => '',
    });
    expect(row?.detail).toBeNull();
  });

  it('an ability keeps its OWN text — a spell\'s rules text never overwrites it', () => {
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    abilityOn(state, bears, 'When Grizzly Bears attacks, draw a card.');
    const [row] = stackRows(stackEntries(state.stack, sourcesFor(state)), {
      ...ctxFor(state),
      oracleOf: () => 'THE SOURCE PERMANENT\'S WHOLE CARD TEXT',
    });
    expect(row?.detail).toBe('When Grizzly Bears attacks, draw a card.');
  });

  it('marks an OPPONENT\'s object as theirs — the fact UX-16 needs first', () => {
    const state = fresh();
    spellOn(state, BOLT, 'B');
    const entries = stackEntries(state.stack, sourcesFor(state));
    const seen = stackRows(entries, { ...ctxFor(state), viewer: 'A' });
    expect(seen[0]?.isOpponents).toBe(true);
    const mine = stackRows(entries, { ...ctxFor(state), viewer: 'B' });
    expect(mine[0]?.isOpponents).toBe(false);
  });

  it('marks NOTHING when nobody said who is looking — no marking beats a guessed one', () => {
    // Guessing "the non-active player is the viewer" would be wrong on every
    // one of the opponent's turns, which is exactly the turn UX-16 is about.
    const state = fresh();
    spellOn(state, BOLT, 'B');
    const rows = stackRows(stackEntries(state.stack, sourcesFor(state)), ctxFor(state));
    expect(rows[0]?.isOpponents).toBe(false);
  });

  it('a kind outside the table is REPORTED as unsupported, not drawn as a spell', () => {
    // Unreachable through the type system, reachable through deserialized data.
    // Widening it to the nearest thing that exists is the silent approximation
    // rule 2 forbids — "it rendered as a spell" is a bug nobody looks for.
    const rogue: StackEntry = {
      instanceId: 1,
      kind: 'delayed-trigger' as StackEntryKind,
      name: 'something core grew later',
      controller: 'A',
      targets: [],
    };
    const [row] = stackRows([rogue], { playerNames: NAMES, nameOf: () => 'x' });
    expect(row?.kindLabel).toBe(UNSUPPORTED_STACK_KIND.label);
    expect(row?.title).toBe('something core grew later');
  });
});

// -----------------------------------------------------------------------------
// the tables are closed, and cover exactly their unions
// -----------------------------------------------------------------------------

describe('the tables stay closed', () => {
  it('every stack kind, target kind and placement has exactly one row', () => {
    expect(Object.keys(STACK_KINDS).sort()).toEqual([...STACK_ENTRY_KINDS].sort());
    expect(Object.keys(STACK_TARGET_KINDS_TABLE).sort()).toEqual([...STACK_TARGET_KINDS].sort());
    expect(Object.keys(STACK_PLACEMENT_TABLE).sort()).toEqual([...STACK_PLACEMENTS].sort());
  });

  it('every kind gets a distinct label, so two kinds can never read as one thing', () => {
    const labels = STACK_ENTRY_KINDS.map((kind) => STACK_KINDS[kind].label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain(UNSUPPORTED_STACK_KIND.label);
  });

  it('only abilities are faced by a source — a spell IS the card on the stack', () => {
    expect(STACK_KINDS.spell.facedBySource).toBe(false);
    expect(STACK_KINDS.trigger.facedBySource).toBe(true);
    expect(STACK_KINDS.activated.facedBySource).toBe(true);
  });

  it('a player target claims no card face, because a seat is not a card', () => {
    expect(STACK_TARGET_KINDS_TABLE.player.hasFace).toBe(false);
    expect(STACK_TARGET_KINDS_TABLE.permanent.hasFace).toBe(true);
  });

  it('each placement names a distinct modifier class, and says what it buys', () => {
    const classes = STACK_PLACEMENTS.map((p) => STACK_PLACEMENT_TABLE[p].className);
    expect(new Set(classes).size).toBe(classes.length);
    for (const name of classes) expect(name.startsWith('stack-panel--')).toBe(true);
    for (const placement of STACK_PLACEMENTS) {
      expect(STACK_PLACEMENT_TABLE[placement].why.length).toBeGreaterThan(40);
    }
    expect(STACK_PLACEMENTS).toContain(DEFAULT_STACK_PLACEMENT);
  });
});

// -----------------------------------------------------------------------------
// geometry: the config is the one source
// -----------------------------------------------------------------------------

describe('stackFaceGeometry — the fan is sized by STACK_PANEL_CONFIG', () => {
  it('draws full-size faces up to maxVisibleEntries and condenses past it', () => {
    const atCap = stackFaceGeometry(STACK_PANEL_CONFIG.maxVisibleEntries);
    expect(atCap.condensed).toBe(false);
    expect(atCap.cardWidthPx).toBe(STACK_PANEL_CONFIG.cardWidthPx);

    const past = stackFaceGeometry(STACK_PANEL_CONFIG.maxVisibleEntries + 1);
    expect(past.condensed).toBe(true);
    expect(past.cardWidthPx).toBe(STACK_PANEL_CONFIG.condensedCardWidthPx);
    // Never HIDDEN, only smaller: a stack object the panel dropped is one the
    // player would be ambushed by.
    expect(past.cardWidthPx).toBeGreaterThan(0);
  });

  it('derives the face height from the card aspect rather than typing a second number', () => {
    for (const count of [1, STACK_PANEL_CONFIG.maxVisibleEntries + 1]) {
      const geo = stackFaceGeometry(count);
      expect(geo.cardHeightPx).toBe(
        Math.round(geo.cardWidthPx * CARD_ASPECT_HEIGHT_OVER_WIDTH),
      );
    }
  });
});

// -----------------------------------------------------------------------------
// the panel renders REAL CARDS
// -----------------------------------------------------------------------------

function renderPanel(props: {
  stack: readonly StackEntry[];
  nameOf?: (id: InstanceId) => string;
  faceOf?: (id: InstanceId) => string | null;
  viewer?: PlayerId;
}): string {
  return renderToStaticMarkup(
    createElement(StackPanel, {
      stack: props.stack,
      names: NAMES,
      nameOf: props.nameOf ?? ((id: InstanceId) => `#${id}`),
      faceOf: props.faceOf,
      viewer: props.viewer,
    }),
  );
}

function imgsOf(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

describe('StackPanel — card faces, not names', () => {
  it('renders the spell\'s actual card image AND its printed rules text', () => {
    const state = fresh();
    spellOn(state, BOLT, 'A');
    const html = renderPanel({ stack: stackEntries(state.stack, sourcesFor(state)) });
    expect(imgsOf(html).length).toBeGreaterThan(0);
    expect(html).toContain(BOLT.name);
    // Read through the app's own card funnel, so the panel says what the spell
    // does without waiting for a hover. Pinned on a distinctive fragment of the
    // real printed text rather than the whole line, which reformats.
    expect(html).toContain('stack-row__detail');
    expect(html.toLowerCase()).toContain('damage');
  });

  it('every image on the panel loads EAGERLY (the play-surface rule)', () => {
    // Same class of bug as report 20260901_202314 ("Some cards were blank. They
    // showed up when I hovered over them."): nothing on a play surface is ever
    // off-screen, so there is nothing to defer. Pinned structurally here as
    // well as in `play-surface-images.test.ts`, because this panel is a NEW
    // image site and a lazy face added here would pass that test untouched.
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    spellOn(state, BOLT, 'A', [bears.instanceId]);
    abilityOn(state, bears, 'When Grizzly Bears attacks, draw a card.');
    const html = renderPanel({
      stack: stackEntries(state.stack, sourcesFor(state)),
      ...sourcesFor(state),
    });
    const imgs = imgsOf(html);
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) expect(img).toContain('loading="eager"');
  });

  it('a stack object with no card degrades to a NAMED plate — no image, no blank rectangle', () => {
    const html = renderPanel({
      stack: [
        {
          instanceId: 1,
          kind: 'trigger',
          name: 'When this token dies, gain 2 life.',
          controller: 'B',
          targets: [],
          faceCardId: null,
          sourceName: 'Bear Cub Token',
        },
      ],
    });
    expect(imgsOf(html)).toHaveLength(0);
    expect(html).toContain('Bear Cub Token');
    expect(html).toContain('play-card__fallback');
  });

  it('marks the top of the stack and SAYS it resolves next', () => {
    const state = fresh();
    spellOn(state, FOREST, 'A');
    spellOn(state, BOLT, 'B');
    const html = renderPanel({ stack: stackEntries(state.stack, sourcesFor(state)) });
    expect(html).toContain('stack-row--top');
    expect(html).toContain('Resolves next');
    expect(html).toContain('2nd to resolve');
    // Exactly one row may claim the top — two would make the claim meaningless.
    expect(html.match(/stack-row--top/g)).toHaveLength(1);
  });

  it('a triggered ability shows the permanent that produced it, not a bare label', () => {
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    abilityOn(state, bears, 'When Grizzly Bears attacks, draw a card.');
    const html = renderPanel({ stack: stackEntries(state.stack, sourcesFor(state)) });
    expect(imgsOf(html).length).toBeGreaterThan(0);
    expect(html).toContain(BEARS.name);
    expect(html).toContain('When Grizzly Bears attacks, draw a card.');
    expect(html).toContain(STACK_KINDS.trigger.label);
  });

  it('targets render as separate related rows, not as a comma-joined string', () => {
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    const forest = place(state, FOREST, 'A');
    spellOn(state, BOLT, 'A', [bears.instanceId, forest.instanceId, 'B']);
    const html = renderPanel({
      stack: stackEntries(state.stack, sourcesFor(state)),
      ...sourcesFor(state),
    });
    // One target element per target, each carrying the direction glyph.
    expect(html.match(/class="stack-target stack-target--/g)).toHaveLength(3);
    expect(html.match(/stack-target__arrow/g)).toHaveLength(3);
    expect(html).toContain(TARGET_ARROW);
    // The old shape — one string with ", " between names — must not come back.
    expect(html).not.toContain(`${BEARS.name}, ${FOREST.name}`);
    // A seat target is named as the seat, through the player-name table.
    expect(html).toContain(NAMES.B);
  });

  it('an opponent\'s spell says so on the row, in words as well as in colour', () => {
    // UX-16 leans on this panel: the held, inspectable opponent spell is drawn
    // here, and "whose is this" is the fact that makes it comprehensible.
    const state = fresh();
    spellOn(state, BOLT, 'B');
    const entries = stackEntries(state.stack, sourcesFor(state));
    const asOpponent = renderPanel({ stack: entries, viewer: 'A' });
    expect(asOpponent).toContain('stack-row--opponents');
    expect(asOpponent).toContain('Opponent');
    // My own spell is not marked, and a board that never says who is looking
    // marks nothing at all.
    expect(renderPanel({ stack: entries, viewer: 'B' })).not.toContain('stack-row--opponents');
    expect(renderPanel({ stack: entries })).not.toContain('stack-row--opponents');
  });

  it('an empty stack renders nothing at all, so the centre column is not permanently split', () => {
    expect(renderPanel({ stack: [] })).toBe('');
  });

  it('still renders a legacy name-only entry — the shape both board adapters pass today', () => {
    // `view-model.StackView` predates UX-1 and carries no face. Until both
    // adapters delegate to `stackEntries`, the panel must keep working and must
    // degrade honestly rather than inventing a card.
    const legacy: StackView = {
      instanceId: 9,
      kind: 'spell',
      name: 'Some Spell',
      controller: 'A',
      targets: ['B'],
    };
    const html = renderPanel({ stack: [legacy] });
    expect(html).toContain('Some Spell');
    expect(html).toContain(NAMES.B);
    expect(imgsOf(html)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// the stylesheet's two cascade traps
// -----------------------------------------------------------------------------

/**
 * Read a stylesheet, CRLF- and comment-agnostic.
 *
 * Copied from `styles-regressions.test.ts` (the repo's CSS-guard idiom) rather
 * than shared, because that file belongs to another lane this run. CRLF trap
 * (CLAUDE.md): committed files are CRLF on a Windows checkout and LF in git, so
 * any byte comparison must normalize first or it false-alarms on every clone.
 * Comments are stripped so a declaration merely NAMED in prose can never
 * satisfy an assertion.
 */
function readStylesheet(relativePath: string): string {
  const raw = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  return raw.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

const stackCss = readStylesheet('../../components/play/stack-panel.css');

describe('stack-panel.css — the parts a Node test can still pin', () => {
  it('the fan reads the config, and hard-codes none of its numbers', () => {
    // Rule 12: two places answering "how far does a card overlap the next one"
    // will eventually answer it differently. The stylesheet must read the
    // custom properties the component derives from STACK_PANEL_CONFIG.
    expect(stackCss).toContain('var(--stack-card-h) * var(--stack-overlap)');
    expect(stackCss).toContain('var(--stack-top-lift)');
    expect(stackCss).toContain('var(--stack-enter-ms)');
    for (const literal of [
      `${STACK_PANEL_CONFIG.cardWidthPx}px`,
      `${STACK_PANEL_CONFIG.condensedCardWidthPx}px`,
      `${STACK_PANEL_CONFIG.topLiftPx}px`,
      `${STACK_PANEL_CONFIG.enterMs}ms`,
      String(STACK_PANEL_CONFIG.overlapFraction),
    ]) {
      expect(stackCss, `stack-panel.css hard-codes ${literal} instead of reading the config`)
        .not.toContain(literal);
    }
  });

  it('the last row un-overlaps AFTER the top row claims its lift', () => {
    // A one-deep stack is BOTH `--top` and `:last-child`, the two rules have the
    // same specificity, and the later one wins. Put `:last-child` first and a
    // single stack object pulls the panel's own bottom edge up over itself —
    // invisible to every other test here, because layout is not computed in
    // Node.
    const top = stackCss.indexOf('.stack-row--top {');
    const last = stackCss.indexOf('.stack-row:last-child {');
    expect(top).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(top);
  });

  it('the face-size rule out-specifies board-fit.css, rather than relying on import order', () => {
    // `board-fit.css` sets `.play-board .play-card.play-card--full { width }` —
    // three classes. At equal specificity the winner is whichever stylesheet the
    // bundler emitted last, which is exactly how board-fit.css lost once before
    // (its own header records it). Ours must carry strictly more classes.
    const BOARD_FIT_CLASS_COUNT = 3;
    const selector = [...stackCss.matchAll(/([^{}]*\.play-card\.play-card--full)\s*\{/g)]
      .map((m) => m[1]!.trim())
      .find((s) => s.includes('stack-panel'));
    expect(selector, 'no stack-panel rule sizes the full card face').toBeDefined();
    const classes = (selector!.match(/\./g) ?? []).length;
    expect(classes).toBeGreaterThan(BOARD_FIT_CLASS_COUNT);
  });

  it('the floating placement is positioned ABSOLUTE, because UX-9 re-roots fixed children', () => {
    // A CSS `perspective` on the board (UX-9) becomes the containing block for
    // every `position: fixed` descendant, which would drag this panel into the
    // tilted scene. `.play-board` is `position: relative`, so `absolute` is
    // correct with or without the perspective.
    const floating = /\.stack-panel\.stack-panel--floating\s*\{([^}]*)\}/.exec(stackCss);
    expect(floating, 'the floating placement has no rule').not.toBeNull();
    expect(floating![1]).toContain('position: absolute');
    expect(floating![1]).not.toContain('position: fixed');
  });

  it('honours prefers-reduced-motion', () => {
    expect(stackCss).toContain('prefers-reduced-motion: reduce');
  });
});

// -----------------------------------------------------------------------------
// the DRY guard the two boards need
// -----------------------------------------------------------------------------

describe('stackEntries and view-model.stackView must not fork', () => {
  it('agree on which objects are on the stack, in what order, named how, aimed where', () => {
    // Both `lib/play/view-model.ts` and `lib/online/board-adapter.ts` hand-roll
    // this answer today, and this lane adds a third producer that the other two
    // are meant to delegate to. Until they do, a silent divergence between them
    // would be attributed to neither (rule 12) — so it is asserted instead.
    const state = fresh();
    const bears = place(state, BEARS, 'B');
    const forest = place(state, FOREST, 'A');
    spellOn(state, BOLT, 'A', [bears.instanceId, 'B']);
    abilityOn(state, forest, '{T}: Add {G}.', { origin: 'activated' });
    abilityOn(state, bears, 'When Grizzly Bears attacks, draw a card.');

    const fromViewModel = buildBoardView(state, 'A', NAMES).stack;
    const fromLane = stackEntries(state.stack, sourcesFor(state));

    expect(fromLane.map((e) => e.instanceId)).toEqual(fromViewModel.map((v) => v.instanceId));
    expect(fromLane.map((e) => e.name)).toEqual(fromViewModel.map((v) => v.name));
    expect(fromLane.map((e) => e.controller)).toEqual(fromViewModel.map((v) => v.controller));
    expect(fromLane.map((e) => e.targets)).toEqual(fromViewModel.map((v) => v.targets));
    // The ONE deliberate difference: the view-model collapses activated
    // abilities onto 'trigger'. The spell/ability partition must still match
    // exactly, so this test follows a view-model that adopts the finer kind
    // rather than freezing the coarse one.
    expect(fromLane.map((e) => e.kind === 'spell')).toEqual(
      fromViewModel.map((v) => v.kind === 'spell'),
    );
  });
});
