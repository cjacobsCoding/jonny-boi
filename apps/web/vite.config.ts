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
 * Vite config for the PWA shell. `vite-plugin-pwa` generates the service worker
 * (offline shell) and injects the web manifest; `registerType: 'autoUpdate'`
 * keeps installed clients current without a manual update prompt.
 */
export default defineConfig({
  base: DEPLOY_BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
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
        icons: [
          {
            src: 'icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
});
