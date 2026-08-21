/**
 * The replay player, imported as TEXT so it can be inlined into a report's
 * `replay.html`. The two specifiers are Vite aliases pointing at the installed
 * `rrweb-player` build (see apps/web/vite.config.ts) — the package's exports map
 * does not publish those files, so they cannot be deep-imported by name.
 */
declare module 'virtual:replay-player-js' {
  const source: string;
  export default source;
}

declare module 'virtual:replay-player-css' {
  const source: string;
  export default source;
}
