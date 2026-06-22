/**
 * Executable entry point. `index.ts` is a pure library (exports `startServer` with
 * no import side-effects, so tests can boot it on an ephemeral port); this module is
 * what `npm run start` / the Docker image actually run, and it boots unconditionally.
 */
import { startServer } from './index.js';

startServer();
