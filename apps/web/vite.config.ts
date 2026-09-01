import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const APP_NAME = 'jonny-boi';
const APP_DESCRIPTION = 'An MTG deck-tuning lab.';
const THEME_COLOR = '#0f1419';
const BACKGROUND_COLOR = '#0f1419';

/**
 * Public base path the app is served from. Defaults to '/' for local dev
 * (`npm run dev`) and root deploys. For a GitHub Pages *project* site the app
 * lives under a sub-path (e.g. '/jonny-boi-app/'), so the deploy pipeline sets
 * `DEPLOY_BASE` to that value — driving Vite's `base` and the PWA manifest
 * scope/start_url together so asset URLs and the service worker scope all match.
 */
const DEPLOY_BASE = process.env.DEPLOY_BASE ?? '/';

/**
 * Build identity, compiled into the bundle for the in-app bug reporter.
 *
 * A report filed from the live PWA is useless if nobody can tell WHICH build it
 * came from — the same symptom on two builds is two different bugs. `GITHUB_SHA`
 * is set automatically by the deploy workflow; a local `npm run build` says
 * 'local' rather than lying about a commit it does not know.
 */
const BUILD_COMMIT = process.env.GITHUB_SHA ?? process.env.BUILD_COMMIT ?? 'local';
const BUILD_TIME = new Date().toISOString();

/**
 * The replay player, resolved to real file paths so it can be inlined as TEXT.
 *
 * A bug report's `replay.html` has to be self-contained — opened days later, on
 * another machine, possibly with no network — so the player is embedded in the
 * page rather than linked. That needs its SOURCE, and `rrweb-player`'s exports
 * map publishes only the module entry and the stylesheet: a `?raw` deep import
 * fails the build with `Missing "./dist/rrweb-player.umd.cjs" specifier`.
 *
 * Resolving the package entry and taking its directory sidesteps the exports map
 * without hard-coding a node_modules path, which npm workspaces are free to
 * hoist wherever they like.
 */
const playerDist = dirname(fileURLToPath(import.meta.resolve('rrweb-player')));

/**
 * Serves the player's source and stylesheet as plain strings, under two virtual
 * module ids, so the reporter can inline them into `replay.html`.
 *
 * A plugin rather than a `?raw` import or a resolve alias, because neither
 * works here: `?raw` on a deep path is refused by the package's exports map,
 * and an alias is matched against the WHOLE specifier, so the `?raw` suffix
 * makes it miss. Reading the file here is also the honest version of what is
 * happening — these bytes are being copied into an artifact, not linked.
 */
function replayPlayerAssets(): Plugin {
  const sources: Record<string, string> = {
    'virtual:replay-player-js': join(playerDist, 'rrweb-player.umd.cjs'),
    'virtual:replay-player-css': join(playerDist, 'style.css'),
  };
  // Rollup's convention for a virtual module id: a leading NUL, which keeps
  // other plugins and the resolver from treating it as a real file path.
  const RESOLVED = '\0';
  return {
    name: 'jonny-boi:replay-player-assets',
    resolveId(id) {
      return id in sources ? RESOLVED + id : null;
    },
    load(id) {
      if (!id.startsWith(RESOLVED)) return null;
      const file = sources[id.slice(RESOLVED.length)];
      if (file === undefined) return null;
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    },
  };
}

/**
 * Vite config for the PWA shell. `vite-plugin-pwa` generates the service worker
 * (offline shell) and injects the web manifest. `registerType: 'prompt'` makes
 * a new build install and then WAIT (no self-skipWaiting) so `main.tsx`'s
 * update policy decides when it takes over — required for deferring updates
 * past a live game, because the 'autoUpdate' worker activates itself on
 * install and can purge the running page's old chunks. Clients stay current:
 * the app applies a waiting update itself the moment no game is live.
 */
/**
 * The largest file the service worker will precache, in bytes.
 *
 * Workbox defaults to 2 MiB. The card pool alone is bigger (§3.71), and this
 * app's whole promise is playing real Magic offline — so the ceiling is raised
 * to cover it and named here rather than buried as a literal in the plugin.
 */
const MAX_PRECACHED_FILE_BYTES = 12 * 1024 * 1024;

export default defineConfig({
  base: DEPLOY_BASE,

  define: {
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Keep the CARD DATA out of the app shell's chunk.
         *
         * The compiled pool and the display index are, between them, most of the
         * download — and neither changes when a component does. In their own
         * chunks they are cached once and skipped by every later build that only
         * touched the UI, and the shell stays small enough to paint before the
         * 4,832 card definitions have finished parsing.
         */
        manualChunks(id: string): string | undefined {
          if (id.includes('expanded-pool')) return 'card-pool';
          if (id.includes('card-index.json')) return 'card-index';
          return undefined;
        },
      },
    },
  },
  plugins: [
    replayPlayerAssets(),
    react(),
    VitePWA({
      registerType: 'prompt',
      /**
       * ⚠️ RAISED FOR THE CARD POOL, deliberately and with the trade stated.
       *
       * Workbox refuses to precache a file over 2 MiB by default, and the whole
       * printed card pool (§3.71 — 4,832 compiled definitions) is larger than
       * that on its own. The default is a sensible guard against precaching a
       * video; here the oversized file IS the application. An offline-first deck
       * lab that cannot open a card offline has precached the wrong things, so
       * the pool is precached and the install is correspondingly bigger.
       *
       * It is split into its own chunk (see `manualChunks`) so the app SHELL
       * still loads without it — the limit is raised for the one asset that
       * needs it, not to hide a bundle nobody is watching.
       */
      workbox: { maximumFileSizeToCacheInBytes: MAX_PRECACHED_FILE_BYTES },
      includeAssets: [
        'icons/favicon-32.png',
        'icons/favicon-16.png',
        'icons/apple-touch-icon.png',
      ],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: APP_DESCRIPTION,
        display: 'standalone',
        theme_color: THEME_COLOR,
        background_color: BACKGROUND_COLOR,
        id: DEPLOY_BASE,
        scope: DEPLOY_BASE,
        start_url: DEPLOY_BASE,
        /**
         * Two purposes, deliberately separate assets (see
         * `scripts/generate-icons.mjs`): `any` is the rounded mark, while
         * `maskable` is the full-bleed variant whose emblem sits inside the 80%
         * safe circle so Android's launcher mask cannot crop it. Declaring one
         * asset as "any maskable" would get the rounded icon cropped.
         */
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
});
