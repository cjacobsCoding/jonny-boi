/**
 * "USED STRIONIC RESONATOR TWICE TO EXILE ENEMY CREATURES AND DIDNT COPY
 * PROPERLY" — bug report 20260911_194411, filed from the live PWA against
 * production build 9b4524a. Console: 0 lines, 0 errors. Nothing threw.
 *
 * ## What was actually wrong
 * NOT the copy. Driven through the real engine the copier is correct: the copy
 * goes on the stack above the original, it inherits the original's aim, the
 * "you may choose new targets" question is asked when there is a second legal
 * creature, and re-aiming it exiles a second creature. What the player COULD NOT
 * SEE is that any of that happened — a copy that exiled a second creature and a
 * copy that fizzled printed BYTE-IDENTICAL game logs:
 *
 *     Player 1 is asked: Choose new targets for the copied ability? (…)
 *     Player 1 answers.
 *     {2}, {t}: copy target triggered ability you control… resolves.
 *     Enters: exile target creature an opponent controls until this leaves (copy) resolves.
 *     Enters: exile target creature an opponent controls until this leaves resolves.
 *
 * Four events carried the whole story and every one of them formatted to `null`:
 * `abilityActivated` (so the log never once names Strionic Resonator),
 * `triggerCopied` (so it never says a copy was made — while `spellCopied`, the
 * other half of the same card family, has said so since it shipped),
 * `triggerFizzled`, and the `zoneChange` that IS the exile. A player whose copy
 * kept the only legal target — CR 707.10c, entirely correct — saw the mana go,
 * the Resonator tap, and nothing else at all.
 *
 * ## What is pinned here
 * The two runs that must NOT read the same, driven through the real `GameSession`
 * from the seat the reporter was in. This is the seam the report is about: the
 * engine already did the right thing, and the log has to say so.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadCardPool } from '@jonny-boi/cards';
import {
  createGame,
  type CardDefinition,
  type CardInstance,
  type GameState,
  type PlayerId,
} from '@jonny-boi/core';
import { GameSession } from './session.js';
import { describeEvents } from './play-format.js';

const SEAT_NAMES: Readonly<Record<PlayerId, string>> = { A: 'Player 1', B: 'Computer' };
const pool = loadCardPool({ onWarn: () => {} });
const registry = buildRegistry();

function card(name: string): CardDefinition {
  const found = pool.getByName(name);
  if (!found) throw new Error(`no pool card named "${name}"`);
  return found;
}

function instance(
  state: GameState,
  def: CardDefinition,
  controller: PlayerId,
  zone: CardInstance['zone'],
): CardInstance {
  return {
    instanceId: state.nextInstanceId++,
    def,
    controller,
    owner: controller,
    zone,
    tapped: false,
    summoningSick: false,
    damageMarked: 0,
    markedByDeathtouch: false,
    counters: {},
  };
}

/**
 * The reported board: Banisher Priest in hand, an untapped Resonator and seven
 * Forests on A's side, and `enemies` creatures on the Computer's.
 *
 * ONE enemy creature is the case the report is really about — with nothing else
 * legal to aim at, CR 707.10c keeps the copy on the creature the original
 * already took, and the original is then the one that does nothing.
 */
function boardWith(enemies: number): { session: GameSession; priestId: number } {
  const plains = card('Plains');
  const created = createGame({
    seed: 41,
    decks: {
      A: { cards: Array.from({ length: 40 }, () => plains) },
      B: { cards: Array.from({ length: 40 }, () => plains) },
    },
    registry,
  });
  const st = created.state;
  const priest = instance(st, card('Banisher Priest'), 'A', 'hand');
  st.players.A.hand = [priest];
  st.players.B.hand = [];
  for (let i = 0; i < 7; i++) st.battlefield.push(instance(st, plains, 'A', 'battlefield'));
  st.battlefield.push(instance(st, card('Strionic Resonator'), 'A', 'battlefield'));
  for (let i = 0; i < enemies; i++) {
    st.battlefield.push(instance(st, card(i === 0 ? 'Grizzly Bears' : 'Runeclaw Bear'), 'B', 'battlefield'));
  }
  let s = GameSession.fromCreated(created, registry, SEAT_NAMES);
  let guard = 0;
  while (s.state.step !== 'precombatMain' && guard++ < 20) s = s.passPriority().session;
  return { session: s, priestId: priest.instanceId };
}

/** Everything the log says from the moment the Resonator is activated. */
interface Played {
  readonly lines: readonly string[];
  readonly exiled: readonly string[];
}

/**
 * Cast the Priest, aim its trigger, copy it with the Resonator, and answer any
 * re-aim question with `retarget` (the SECOND enemy) or the inherited one.
 */
function playIt(enemies: number, retarget: boolean): Played {
  const built = boardWith(enemies);
  let s = built.session;
  s = s.castWithAutoTap(built.priestId, []).session;

  // Resolve the Priest so its ETB trigger reaches the stack, answering the
  // trigger's own target question with the FIRST enemy creature.
  const enemyIds = s.state.battlefield.filter((p) => p.controller === 'B').map((p) => p.instanceId);
  let guard = 0;
  while (guard++ < 20 && !s.state.stack.some((o) => o.kind === 'trigger' && o.targets.length > 0)) {
    const choice = s.pendingChoice;
    if (choice) {
      s = s.answerChoice({ kind: 'selectTargets', targets: [enemyIds[0]!] }).session;
      continue;
    }
    if (s.state.stack.length === 0) break;
    s = s.passPriority().session;
  }
  const trigger = s.state.stack.find((o) => o.kind === 'trigger');
  expect(trigger, 'the ETB trigger must be on the stack, aimed').toBeDefined();

  // FROM HERE ON is what the player watching the log sees.
  const from = s.events.length;
  const reso = s.state.battlefield.find((p) => p.def.name === 'Strionic Resonator')!;
  const act = s.activateWithAutoTap(reso.instanceId, 0, [trigger!.instanceId]);
  expect(act.rejected, 'the Resonator activation is legal here').toBeNull();
  s = act.session;

  let g2 = 0;
  while (g2++ < 30 && (s.state.stack.length > 0 || s.pendingChoice)) {
    const choice = s.pendingChoice;
    if (choice) {
      const pick = retarget ? (enemyIds[1] ?? enemyIds[0]!) : enemyIds[0]!;
      s = s.answerChoice({ kind: 'selectTargets', targets: [pick] }).session;
      continue;
    }
    s = s.passPriority().session;
  }

  return {
    lines: describeEvents(s.events.slice(from), { name: s.nameOf, playerName: s.playerName }).map(
      (l) => l.text,
    ),
    exiled: s.state.players.B.exile.map((c) => c.def.name),
  };
}

describe('Strionic Resonator says what it did (report 20260911_194411)', () => {
  it('names the permanent whose ability was activated', () => {
    // The log never said "Strionic Resonator" anywhere. The only trace of the
    // activation was the ability's raw oracle text arriving as a `stackResolved`
    // label — lowercased, unpunctuated, and naming no card.
    const played = playIt(2, true);
    expect(played.lines).toContain('Player 1 activates Strionic Resonator.');
  });

  it('says a copy was made — the same sentence a COPIED SPELL has always got', () => {
    const played = playIt(2, true);
    expect(
      played.lines.some((l) => l.startsWith('Player 1 copies ')),
      `no "copies" line in:\n${played.lines.join('\n')}`,
    ).toBe(true);
  });

  it('says the creature was exiled, both times', () => {
    const played = playIt(2, true);
    expect(played.exiled, 'the copy and the original each took one').toHaveLength(2);
    const exiles = played.lines.filter((l) => l.includes('exiled'));
    expect(exiles, `one line per exile; got:\n${played.lines.join('\n')}`).toHaveLength(2);
  });

  it('THE REPORT: with one enemy creature the copy is not re-aimable — and the log must say so', () => {
    // CR 707.10c: the copy has the same targets, and there is no second legal
    // creature to move it to, so the copy exiles the Bears and the ORIGINAL then
    // has no legal target left. That is correct. What made it a bug report is
    // that the app said none of it.
    const played = playIt(1, false);
    expect(played.exiled, 'one creature, so one exile — correct rules').toEqual(['Grizzly Bears']);
    expect(played.lines).toContain('Player 1 activates Strionic Resonator.');
    expect(
      played.lines.some((l) => l.startsWith('Player 1 copies ')),
      'the copy is announced even when it cannot be re-aimed',
    ).toBe(true);
    expect(
      played.lines.some((l) => l.includes('Grizzly Bears') && l.includes('exiled')),
      'the exile the player asked for is named',
    ).toBe(true);
    // And the half that did nothing SAYS it did nothing, instead of printing the
    // same "… resolves." as the half that worked (§3.55, `triggerRemovedFromStack`).
    expect(
      played.lines.some((l) => l.includes('nothing happens')),
      `the fizzled half must explain itself; got:\n${played.lines.join('\n')}`,
    ).toBe(true);
  });

  it('the two outcomes do not read the same — the defect stated as an invariant', () => {
    // THE assertion the report reduces to. Before the fix these two logs were
    // byte-identical while one exiled two creatures and the other exiled one.
    const both = playIt(2, true);
    const one = playIt(2, false);
    expect(both.exiled).toHaveLength(2);
    expect(one.exiled).toHaveLength(1);
    expect(both.lines.join('\n')).not.toEqual(one.lines.join('\n'));
  });
});

/**
 * THE SIBLING — spell copies (DESIGN §3.24). Measured, not assumed: `spellCopied`
 * has had a log line since it shipped, so a COPIED SPELL is announced and the
 * reported defect does not reach it. What it DID share is the other half of
 * "a copy is illegible": a spell copy is not a card and ceases to exist the
 * instant it resolves (CR 704.5e), so by the time the feed rendered, the damage
 * it dealt read `#94 deals 3 to Grizzly Bears` — an id no player can match to
 * anything.
 */
describe('a copied SPELL is legible too', () => {
  it('names the copy that dealt the damage, after the copy has ceased to exist', () => {
    const mountain = card('Mountain');
    const created = createGame({
      seed: 7,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => mountain) },
        B: { cards: Array.from({ length: 40 }, () => mountain) },
      },
      registry,
    });
    const st = created.state;
    const bolt = instance(st, card('Lightning Bolt'), 'A', 'hand');
    const twin = instance(st, card('Reverberate'), 'A', 'hand');
    st.players.A.hand = [bolt, twin];
    st.players.B.hand = [];
    for (let i = 0; i < 8; i++) st.battlefield.push(instance(st, mountain, 'A', 'battlefield'));
    const bear = instance(st, card('Grizzly Bears'), 'B', 'battlefield');
    st.battlefield.push(bear);
    let s = GameSession.fromCreated(created, registry, SEAT_NAMES);
    let g = 0;
    while (s.state.step !== 'precombatMain' && g++ < 20) s = s.passPriority().session;

    s = s.castWithAutoTap(bolt.instanceId, [bear.instanceId]).session;
    const from = s.events.length;
    s = s.castWithAutoTap(twin.instanceId, [bolt.instanceId]).session;
    let g2 = 0;
    while (g2++ < 40 && (s.state.stack.length > 0 || s.pendingChoice)) {
      if (s.pendingChoice) {
        s = s.answerChoice({ kind: 'selectTargets', targets: [bear.instanceId] }).session;
        continue;
      }
      s = s.passPriority().session;
    }
    const lines = describeEvents(s.events.slice(from), { name: s.nameOf, playerName: s.playerName }).map(
      (l) => l.text,
    );
    expect(lines, 'the copy is announced — this half was never broken').toContain(
      'Player 1 copies Lightning Bolt.',
    );
    expect(
      lines.some((l) => /^#\d+ /.test(l)),
      `no line may open with a bare instance id; got:\n${lines.join('\n')}`,
    ).toBe(false);
    expect(lines).toContain('Lightning Bolt deals 3 to Grizzly Bears.');
  });
});

/**
 * THE REPORTER ACTIVATED IT **TWICE**, and the brief's candidate 3 was that the
 * second activation aimed at the wrong object. Half of that is real and is the
 * card working: while the first Resonator's own ability is still on the stack it
 * is the only other object there, and "copy target **TRIGGERED** ability"
 * refuses it (CR 602 vs 603 — the `origin: 'activated'` stamp). A second
 * Resonator activated in that window can only re-copy the SAME original.
 *
 * Once the first ability RESOLVES, the copy it made is itself a triggered
 * ability you control, and copying that is legal. Pinned here through the
 * engine's own menu rather than a hand-built action, so a menu that drifted
 * narrower or wider than the rejection path fails this.
 */
describe('two Resonators, one trigger', () => {
  it('refuses the first Resonator ABILITY as a target, and accepts the copy it makes', () => {
    const plains = card('Plains');
    const created = createGame({
      seed: 41,
      decks: {
        A: { cards: Array.from({ length: 40 }, () => plains) },
        B: { cards: Array.from({ length: 40 }, () => plains) },
      },
      registry,
    });
    const st = created.state;
    const priest = instance(st, card('Banisher Priest'), 'A', 'hand');
    st.players.A.hand = [priest];
    st.players.B.hand = [];
    for (let i = 0; i < 10; i++) st.battlefield.push(instance(st, plains, 'A', 'battlefield'));
    const resoA = instance(st, card('Strionic Resonator'), 'A', 'battlefield');
    const resoB = instance(st, card('Strionic Resonator'), 'A', 'battlefield');
    st.battlefield.push(resoA, resoB);
    const enemies = ['Grizzly Bears', 'Runeclaw Bear', 'Llanowar Elves'].map((n) =>
      instance(st, card(n), 'B', 'battlefield'),
    );
    for (const e of enemies) st.battlefield.push(e);
    let s = GameSession.fromCreated(created, registry, SEAT_NAMES);
    let guard = 0;
    while (s.state.step !== 'precombatMain' && guard++ < 20) s = s.passPriority().session;

    s = s.castWithAutoTap(priest.instanceId, []).session;
    let g1 = 0;
    while (g1++ < 20 && !s.state.stack.some((o) => o.kind === 'trigger' && o.targets.length > 0)) {
      if (s.pendingChoice) {
        s = s.answerChoice({ kind: 'selectTargets', targets: [enemies[0]!.instanceId] }).session;
        continue;
      }
      if (s.state.stack.length === 0) break;
      s = s.passPriority().session;
    }
    const original = s.state.stack.find((o) => o.kind === 'trigger')!;
    const from = s.events.length;

    // FIRST activation, on the original trigger; the copy is re-aimed at enemy 2.
    s = s.activateWithAutoTap(resoA.instanceId, 0, [original.instanceId]).session;

    // While that ability is ON the stack, the second Resonator may NOT name it.
    const resonatorAim = (session: GameSession, source: number): readonly (number | PlayerId)[] =>
      session
        .abilityOptions()
        .filter((o) => o.instanceId === source)
        .flatMap((o) => (o.targets ?? []).map((t) => t.target));
    const activatedAbility = s.state.stack.find(
      (o) => o.kind === 'trigger' && o.instanceId !== original.instanceId,
    );
    expect(activatedAbility, "the Resonator's own ability is on the stack").toBeDefined();
    expect(
      resonatorAim(s, resoB.instanceId),
      'an ACTIVATED ability is not a triggered one, however it sits on the stack',
    ).not.toContain(activatedAbility!.instanceId);

    // Let it resolve. Now the COPY is a triggered ability you control.
    const isCopy = (o: { kind: string; label?: string }): boolean =>
      o.kind === 'trigger' && (o.label ?? '').endsWith('(copy)');
    let g2 = 0;
    while (g2++ < 12 && !s.state.stack.some((o) => isCopy(o as never))) {
      if (s.pendingChoice) {
        s = s.answerChoice({ kind: 'selectTargets', targets: [enemies[1]!.instanceId] }).session;
        continue;
      }
      s = s.passPriority().session;
    }
    const copy = s.state.stack.find((o) => isCopy(o as never));
    expect(copy, 'the copy is on the stack above the original').toBeDefined();
    expect(resonatorAim(s, resoB.instanceId), 'a copy IS a triggered ability you control').toContain(
      copy!.instanceId,
    );

    const second = s.activateWithAutoTap(resoB.instanceId, 0, [copy!.instanceId]);
    expect(second.rejected, 'copying a copy is legal').toBeNull();
    s = second.session;

    let g3 = 0;
    while (g3++ < 40 && (s.state.stack.length > 0 || s.pendingChoice)) {
      if (s.pendingChoice) {
        s = s.answerChoice({ kind: 'selectTargets', targets: [enemies[2]!.instanceId] }).session;
        continue;
      }
      s = s.passPriority().session;
    }

    const lines = describeEvents(s.events.slice(from), { name: s.nameOf, playerName: s.playerName }).map(
      (l) => l.text,
    );
    expect(
      lines.filter((l) => l === 'Player 1 activates Strionic Resonator.'),
      `both activations named; got:\n${lines.join('\n')}`,
    ).toHaveLength(2);
    expect(
      lines.filter((l) => l.startsWith('Player 1 copies ')),
      `both copies announced; got:\n${lines.join('\n')}`,
    ).toHaveLength(2);
    // Three halves, three different creatures — what the reporter expected to see.
    expect(new Set(s.state.players.B.exile.map((c) => c.def.name)).size).toBe(3);
  });
});
