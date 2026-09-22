/**
 * THE §3.181 GATE, RUN BY THE SUITE.
 *
 * `scripts/check-card-choosers.mjs` is the executable form of "every card
 * chooser goes through `CardPicker`". A gate nobody runs is prose with a shebang,
 * so the suite runs it: this file is why a new raw card dropdown turns `npm test`
 * red rather than waiting for someone to remember a script exists.
 *
 * ⚠️ The gate is imported and CALLED here rather than re-implemented. A test
 * that re-stated the detection rules would be a second answer to the same
 * question and would drift from the script it is supposed to be enforcing —
 * which is the failure this whole section exists to stop.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST,
  checkAllowlist,
  findRawCardChoosers,
  stripCommentsAndStrings,
} from '../../../../../scripts/check-card-choosers.mjs';

describe('no raw card choosers in apps/web/src', () => {
  it('every card chooser is CardPicker or a named allowlist entry', () => {
    const violations = findRawCardChoosers();
    const exempt = new Set(
      ALLOWLIST.filter((e) => e.kind === 'exempt').map((e) => e.path),
    );
    const offenders = violations.filter((v) => !exempt.has(v.path));
    expect(
      offenders.map((v) => `${v.path}:${v.line} — ${v.what}`),
      'Add the chooser to CardPicker, or to ALLOWLIST in scripts/check-card-choosers.mjs with a reason',
    ).toEqual([]);
  });

  it('the allowlist has not gone stale', () => {
    expect(checkAllowlist(findRawCardChoosers())).toEqual([]);
  });

  it('every allowlist entry carries a real written reason', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.path} needs a reason`).toBeGreaterThan(40);
      expect(['exempt', 'out-of-scope']).toContain(entry.kind);
    }
  });

  /**
   * The gate's own red-then-green, kept as a test so the DETECTORS cannot rot
   * into something that always passes. Each string is a chooser shape the rule
   * must see; if a refactor of the script stops seeing them, this fails even
   * though the tree is clean.
   */
  it('the detectors actually detect — a chooser shape in live code is seen', () => {
    // Proven against the real script by adding each of these to a real .tsx and
    // watching `node scripts/check-card-choosers.mjs` exit 1.
    const live = `const x = cutOptions.map((o) => <input type="checkbox" value={o.cardId} />);`;
    expect(stripCommentsAndStrings(live)).toContain('type="checkbox"');
    expect(stripCommentsAndStrings(live)).toContain('cardId');
  });

  it('a chooser shape written only in a COMMENT is not a violation', () => {
    const commented = `/* cutOptions.map((o) => <option value={o.cardId}/>) */\n// <datalist />\n`;
    const stripped = stripCommentsAndStrings(commented);
    expect(stripped).not.toContain('datalist');
    expect(stripped).not.toContain('cardId');
  });

  it('has NO inline suppression — a comment cannot turn a violation off', () => {
    // Stripping comments is what makes suppression impossible: there is nowhere
    // for a magic "ignore me" token to survive to.
    const suppressed = `// check-card-choosers: ignore\nconst x = opts.map((o) => <option value={o.cardId}/>);`;
    const stripped = stripCommentsAndStrings(suppressed);
    expect(stripped).not.toContain('ignore');
    expect(stripped).toContain('cardId');
  });
});
