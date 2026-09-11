/**
 * THE UX-4 GUARD — one cancel, not one per prompt.
 *
 * Caleb: *"Anytime I activate an ability or anything that targets cards, until
 * I've actually chosen the targets, I should be able to back out of the
 * spell/ability as long as nothing has mutated game state yet."*
 *
 * The SHAPE of the bug this guards (lane B's recon named it): the board holds
 * several independent "half-decided" states, each with its own ad-hoc Cancel
 * button, and a new one arrives with a seventh cancel that behaves subtly
 * differently — or with none at all. So the assertions here are about the CLASS:
 *
 *   1. every pre-commit `useState` in `PlayBoard` is cleared by `resetTransient`;
 *   2. every one of them is named in the `preCommitOpen` predicate, so Escape is
 *      live whenever any of them is;
 *   3. `resetTransient` dispatches NOTHING — that is what makes it idempotent
 *      and side-effect-free, which is UX-4's whole claim;
 *   4. the key is read from `PROPOSAL_CONFIG`, not typed as a literal.
 *
 * A source test, because the thing being asserted is a relationship between
 * declarations rather than anything a render produces.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_CONFIG } from '../../lib/play/play-config.js';

const source = readFileSync(
  fileURLToPath(new URL('./PlayBoard.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

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

/**
 * The board's pre-commit states, DERIVED from the source rather than listed
 * here: anything the component holds whose name says it is a decision in
 * progress. Deriving it is the point — a seventh one added tomorrow is caught
 * without anybody remembering to update this file.
 */
const PRE_COMMIT_STATE_NAMES = [
  ...source.matchAll(/const \[(pending[A-Za-z]*|handChoice|manaPicker|abilitySource), set[A-Za-z]*\]/g),
].map((m) => m[1] as string);

const resetBody = functionBody('resetTransient');
const preCommitBlock = source.slice(
  source.indexOf('const preCommitOpen ='),
  source.indexOf(';', source.indexOf('const preCommitOpen =')),
);

describe('there is ONE cancel, and it covers everything pre-commit', () => {
  it('the board really does hold several of these — otherwise this test proves nothing', () => {
    expect(PRE_COMMIT_STATE_NAMES.length).toBeGreaterThanOrEqual(5);
    expect(PRE_COMMIT_STATE_NAMES).toContain('pendingCast');
    expect(PRE_COMMIT_STATE_NAMES).toContain('manaPicker');
    expect(PRE_COMMIT_STATE_NAMES).toContain('pendingAbility');
  });

  it('every one of them is cleared by `resetTransient`', () => {
    for (const name of PRE_COMMIT_STATE_NAMES) {
      const setter = `set${name[0]?.toUpperCase() ?? ''}${name.slice(1)}(`;
      expect(resetBody, `${name} is not cleared by resetTransient`).toContain(setter);
    }
  });

  it('every one of them makes the cancel affordance live', () => {
    for (const name of PRE_COMMIT_STATE_NAMES) {
      // `pendingCastAsks` rides `pendingCast` and is a flag, not a decision.
      if (name === 'pendingCastAsks') continue;
      expect(preCommitBlock, `${name} is missing from preCommitOpen`).toContain(name);
    }
  });

  it('`resetTransient` DISPATCHES NOTHING — that is what makes cancelling free', () => {
    // A `session.` call here would mean cancelling changed the game, which is
    // precisely what UX-3's acceptance line forbids ("zero game-state mutation
    // is visible; cancel restores byte-identical state").
    expect(resetBody).not.toMatch(/session\./);
    expect(resetBody).not.toMatch(/onSubmit|submit\(/);
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
    expect(source).toContain('{PROPOSAL_CONFIG.cancelKey} backs out');
  });
});
