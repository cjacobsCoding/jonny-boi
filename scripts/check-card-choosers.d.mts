/**
 * Types for `check-card-choosers.mjs` (DESIGN §3.181).
 *
 * The gate is plain `.mjs` so `node scripts/check-card-choosers.mjs` works with
 * no build step — which is the point of a gate. But `apps/web/tsconfig.json`
 * has NO `exclude`, so unlike every `packages/*` config it DOES type-check its
 * own test files, and `no-raw-card-dropdown.test.ts` imports this script.
 * Without this declaration that import is an implicit `any` and
 * `npm run build` fails with TS7016 — which is exactly how it was found.
 *
 * Hand-authored rather than generated: the script is the source of truth, and a
 * generated `.d.ts` would need a build step that the gate deliberately avoids.
 * If a signature here drifts from the script, the test that calls it stops
 * compiling, which is the intended alarm.
 */

/** One place a card chooser was found. */
export interface CardChooserViolation {
  /** Repo-relative, forward slashes. */
  readonly path: string;
  /** Which row of the shape table matched. */
  readonly shape: string;
  /** Human-readable description of the shape. */
  readonly what: string;
  readonly line: number;
}

/** An entry in the gate's only escape hatch. */
export interface CardChooserAllowlistEntry {
  readonly path: string;
  /**
   * `exempt`       — a real hit that is allowed (must still be a hit).
   * `out-of-scope` — a card-choosing surface the detectors cannot see (must NOT be a hit).
   */
  readonly kind: 'exempt' | 'out-of-scope';
  readonly reason: string;
}

export declare const ALLOWLIST: readonly CardChooserAllowlistEntry[];

/** Every raw card chooser under `apps/web/src`; the allowlist is NOT applied. */
export declare function findRawCardChoosers(root?: string): CardChooserViolation[];

/** Problems with the allowlist itself — stale entries, missing files, no reason. */
export declare function checkAllowlist(violations: readonly CardChooserViolation[]): string[];

/** Remove comments so a mention of a chooser in prose is not a violation. */
export declare function stripCommentsAndStrings(source: string): string;

/** Run the whole gate; returns the number of failures (0 = pass). */
export declare function run(options?: { list?: boolean }): number;
