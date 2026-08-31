import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import { SW_UPDATE_CHECK_INTERVAL_MS } from './lib/config.js';
import { appUpdater } from './lib/update/updater.js';
import './styles.css';

/**
 * PWA freshness WITHOUT interruption. The service worker is registered in
 * 'prompt' mode (vite.config.ts): a new build installs in the background and
 * then WAITS — the old worker keeps serving the running page's assets — until
 * this app decides to let it take over. That decision is the updater's policy
 * (lib/update/update-decision.ts): apply immediately when no game is live, or
 * defer behind a small pill until the live game is left; either way the
 * updater force-flushes the persisted game state and writes the resume flag
 * BEFORE `updateSW(true)` performs skipWaiting + reload, so the reloaded app
 * comes back to the same screen, scroll position, and exact game state.
 *
 * This replaces the old reload-on-controllerchange, which yanked the page the
 * moment a new worker took control — mid-game, mid-anything. (Its original
 * job, un-stale-ing returning clients, is preserved: on a stale launch the
 * waiting worker is announced, no game is live yet, and the policy applies it
 * right away.) 'prompt' mode is REQUIRED for deferral: the 'autoUpdate'
 * worker skipWaiting()s itself on install, and once it controls the page it
 * may purge the old build's lazy chunks out from under the running app.
 *
 * The interval re-check exists for marathon sessions that never reload;
 * `update()` rejecting (offline) is expected and ignored.
 */
const updateSW = registerSW({
  onNeedRefresh() {
    appUpdater.onUpdateReady(() => {
      void updateSW(true);
    });
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    window.setInterval(() => {
      registration.update().catch(() => {
        // Offline or the host is unreachable — try again next interval.
      });
    }, SW_UPDATE_CHECK_INTERVAL_MS);
  },
  onRegisterError() {
    // No SW (unsupported browser, dev server): the app still runs, just un-cached.
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
