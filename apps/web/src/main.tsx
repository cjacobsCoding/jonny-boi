import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/**
 * PWA freshness: the service worker (registerType 'autoUpdate') installs a new
 * build in the background, but the page already on screen keeps running the OLD
 * cached bundle until something reloads it. That staleness is user-visible — e.g.
 * a returning player ran a build whose baked-in game-server URL predated the live
 * server and saw "Connection problem". So when a new worker takes control, reload
 * once to pick up the new assets.
 *
 * Guards: only reload when a worker was ALREADY controlling this page at load
 * time. The very first visit goes null -> worker (clientsClaim) while the page is
 * already serving fresh network assets, so reloading there would be pointless —
 * and unguarded it risks a reload loop. `reloading` makes it at-most-once.
 */
if ('serviceWorker' in navigator) {
  const wasControlledAtLoad = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlledAtLoad || reloading) return;
    reloading = true;
    window.location.reload();
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
