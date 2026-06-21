import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const APP_NAME = 'jonny-boi';
const APP_DESCRIPTION = 'An MTG deck-tuning lab.';
const THEME_COLOR = '#0f1419';
const BACKGROUND_COLOR = '#0f1419';

/**
 * Vite config for the PWA shell. `vite-plugin-pwa` generates the service worker
 * (offline shell) and injects the web manifest; `registerType: 'autoUpdate'`
 * keeps installed clients current without a manual update prompt.
 */
export default defineConfig({
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
        start_url: '/',
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
