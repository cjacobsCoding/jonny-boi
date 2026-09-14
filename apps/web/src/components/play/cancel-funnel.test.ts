/**
 * THE UX-4 GUARD — one cancel, and it touches ONLY what it owns.
 *
 * Caleb: *"Anytime I activate an ability or anything that targets cards, until
 * I've actually chosen the targets, I should be able to back out of the
 * spell/ability as long as nothing has mutated game state yet."*
 *
 * ## Two shapes, and this file now guards both
 *
 * **Shape 1 (guarded since wave 1).** The board holds several independent
 * "half-decided" states, each acquires its own ad-hoc Cancel button, and the
 * next one arrives with a seventh cancel that behaves subtly differently — or
 * with none at all.
 *
 * **Shape 2 (a LIVE DEFECT this file could not see, and the reason it was
 * rewritten).** The one cancel funnel clears too MUCH. `resetTransient` also
 * called `setChosenAttackers`, `setWalkerAssign`, `setBlockAssign` and
 * `setActiveBlockTarget`, so pressing Escape to back out of an instant during
 * the declare-blockers step threw away every block the player had drafted.
 * UX-4's acceptance line is "returns to the pre-proposal board WITH NO SIDE
 * EFFECTS", and destroying a combat draft is the most expensive side effect on
 * this surface.
 *
 * The old derivation is exactly why it was invisible: it built its state list
 * from `/(pending[A-Za-z]*|handChoice|manaPicker|abilitySource)/`, a hand-picked
 * subset which by construction contained none of the four combat setters that
 * were hiding inside the funnel. So the derivation now runs the other way —
 * **from what the funnels actually clear** — and the load-bearing assertion is
 * that the two scopes are DISJOINT.
 *
 * A source test, because the thing asserted is a relationship between
 * declarations rather than anything a render produces.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_CONFIG } from '../../lib/play/play-config.js';

const source = readFileSync(fileURLToPath(new URL('./PlayBoard.tsx', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

function functionBody(name: string): string {
  const start = source.indexOf(`const ${name} = (`);
  expect(start, `${name} not found`).toBeGreaterThan(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** `setFoo(` → `foo` — the state a setter call clears. */
function statesClearedBy(body: string): readonly string[] {
  return [...body.matchAll(/\bset([A-Z][A-Za-z]*)\(/g)].map(
    (m) => `${(m[1] as string)[0]?.toLowerCase() ?? ''}${(m[1] as string).slice(1)}`,
  );
}

/** Every `useState` the board declares, whatever it is for. */
const ALL_STATE_NAMES = [...source.matchAll(/const \[([A-Za-z][A-Za-z0-9]*), set[A-Za-z]+\]/g)].map(
  (m) => m[1] as string,
);

const proposalBody = functionBody('resetProposal');
const combatBody = functionBody('clearCombatDraft');
const proposalClears = statesClearedBy(proposalBody);
const combatClears = statesClearedBy(combatBody);

/** The states `preCommitOpen` names — "is a proposal-shaped thing open?". */
const preCommitBlock = source.slice(
  source.indexOf('const preCommitOpen ='),
  source.indexOf(';', source.indexOf('const preCommitOpen =')),
);
const preCommitNames = ALL_STATE_NAMES.filter((name) => preCommitBlock.includes(name));

/**
 * States that RIDE a pre-commit state rather than being separately openable, so
 * they are cleared by the funnel without appearing in `preCommitOpen`. Listed
 * with the state each rides; the test checks that state really is pre-commit,
 * so a new name cannot be parked here to dodge an assertion.
 */
const RIDERS: Readonly<Record<string, string>> = {
  fundingSources: 'proposal',
  castRequestedMana: 'proposal',
};

describe('there is ONE cancel, and it covers everything pre-commit', () => {
  it('the board really does hold several of these — otherwise this test proves nothing', () => {
    expect(preCommitNames.length).toBeGreaterThanOrEqual(3);
    expect(preCommitNames).toContain('proposal');
    expect(proposalClears.length).toBeGreaterThanOrEqual(4);
  });

  it('every pre-commit state is cleared by the proposal funnel', () => {
    for (const name of preCommitNames) {
      expect(proposalClears, `${name} is not cleared by resetProposal`).toContain(name);
    }
  });

  it('the funnel clears NOTHING that is not pre-commit (or a declared rider)', () => {
    for (const name of proposalClears) {
      if (preCommitNames.includes(name)) continue;
      const rides = RIDERS[name];
      expect(rides, `resetProposal clears ${name}, which nothing declares as pre-commit`).toBeDefined();
      expect(preCommitNames, `${name} claims to ride ${rides}, which is not pre-commit`).toContain(rides);
    }
  });

  it('`resetProposal` DISPATCHES NOTHING — that is what makes cancelling free', () => {
    // A `session.` call here would mean cancelling changed the game, which is
    // precisely what UX-3's acceptance line forbids ("zero game-state mutation
    // is visible; cancel restores byte-identical state").
    expect(proposalBody).not.toMatch(/session\./);
    expect(proposalBody).not.toMatch(/onSubmit|submit\(/);
  });

  it('Escape is the key, and it comes from the config', () => {
    expect(source).toContain('event.key !== PROPOSAL_CONFIG.cancelKey');
    expect(PROPOSAL_CONFIG.cancelKey).toBe('Escape');
    // The literal must not be typed in any CODE in the board, or the config
    // knob is a knob two of its three consumers ignore. Comments are stripped
    // first, because the reason a rule exists is allowed to name the value.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain("'Escape'");
    expect(code).not.toContain('"Escape"');
  });

  it('the affordance is SAID, not merely implemented', () => {
    // "The cancel affordance disappearing is itself a UX failure if it is
    // silent" — a control the player cannot see is a control they do not have.
    expect(source).toContain('play-cancel-hint');
    expect(source).toContain('PROPOSAL_CONFIG.cancelKey} backs out');
  });
});

describe('CANCELLING A CAST DOES NOT DESTROY A COMBAT DRAFT', () => {
  it('the combat draft is a scope of its own, and it is not empty', () => {
    // Derived from the funnel, not written down here: whatever the board calls
    // its draft, this is the set the cancel may not touch.
    expect(combatClears.length, 'clearCombatDraft clears nothing').toBeGreaterThanOrEqual(4);
    for (const name of combatClears) {
      expect(ALL_STATE_NAMES, `${name} is not a board state`).toContain(name);
    }
  });

  it('THE DEFECT: the two scopes are disjoint', () => {
    // This is the assertion the old regex could not make. `resetTransient` used
    // to clear all four combat setters, and every test in this file passed.
    for (const name of combatClears) {
      expect(
        proposalClears,
        `backing out of a cast would throw away ${name} — that is a side effect UX-4 forbids`,
      ).not.toContain(name);
    }
    for (const name of proposalClears) {
      expect(combatClears, `${name} is cleared by both funnels`).not.toContain(name);
    }
  });

  it('`clearCombatDraft` dispatches nothing either', () => {
    expect(combatBody).not.toMatch(/session\./);
    expect(combatBody).not.toMatch(/onSubmit|submit\(/);
  });

  it('the draft is cleared by the two declarations that CONSUME it', () => {
    expect(source).toContain('onDeclareAttackers');
    // `run(fn, true)` is the "also clear the combat draft" argument, passed by
    // exactly the two declare handlers and by nothing else.
    const withDraftClear = [...source.matchAll(/run\([\s\S]{0,160}?\),\s*true\)/g)];
    expect(withDraftClear.length, 'no commit path clears the draft, so it goes stale').toBe(2);
  });

  it('…and by leaving the declare step it belongs to', () => {
    // The auto-passer and the AI seat move steps without this board knowing, so
    // a commit-path clear alone cannot keep the draft fresh.
    expect(source).toContain("if (step !== 'declareAttackers')");
    expect(source).toContain("if (step !== 'declareBlockers')");
  });
});
