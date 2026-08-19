import { defineConfig } from 'vite';
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
 * Vite config for the PWA shell. `vite-plugin-pwa` generates the service worker
 * (offline shell) and injects the web manifest; `registerType: 'autoUpdate'`
 * keeps installed clients current without a manual update prompt.
 */
export default defineConfig({
  base: DEPLOY_BASE,
  define: {
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
