/**
 * The build the app is actually running, for the bug reporter's `build` line.
 *
 * `__BUILD_COMMIT__` / `__BUILD_TIME__` are compiled in by `vite.config.ts`. The
 * `typeof` guards are not decoration: this module is imported by Vitest too,
 * where Vite's `define` is not applied, and an undeclared identifier would be a
 * ReferenceError at import time — a test suite broken by a debug tool.
 */
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export interface BuildInfo {
  readonly commit: string;
  readonly builtAt: string;
  readonly mode: string;
}

export function buildInfo(): BuildInfo {
  return {
    commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
    builtAt: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'unknown',
    mode: import.meta.env.MODE,
  };
}

/** One line: what a reader wants at the top of a report. */
export function buildLine(): string {
  const info = buildInfo();
  return `${info.commit} (${info.mode}, built ${info.builtAt})`;
}
