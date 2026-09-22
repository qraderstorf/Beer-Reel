import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Capacitor} from '@capacitor/core';
import App from './App.tsx';
import './index.css';

// Native builds bundle the web assets locally (see capacitor.config.ts), so
// there's no same-origin server for relative "/api/..." calls to resolve
// against like there is on the web. Point those calls at the deployed
// backend instead. Every fetch() in this app already targets a relative
// "/api/..." path, so patching fetch here covers all of them without
// touching each call site - update NATIVE_API_BASE if the backend moves.
const NATIVE_API_BASE = 'https://beer-real-git-300733292627.us-west2.run.app';

if (Capacitor.isNativePlatform()) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return originalFetch(NATIVE_API_BASE + input, init);
    }
    if (input instanceof Request && input.url.startsWith('/api/')) {
      return originalFetch(new Request(NATIVE_API_BASE + input.url, input), init);
    }
    return originalFetch(input, init);
  };
}

// Safely attempt a single reload if a genuine chunk error occurs, with strict throttling
function safeReloadOnce(reason: string) {
  const lastReload = sessionStorage.getItem('pwa_last_reload');
  const now = Date.now();
  if (!lastReload || now - parseInt(lastReload, 10) > 30000) {
    sessionStorage.setItem('pwa_last_reload', now.toString());
    console.warn('[PWA] Recovering page due to asset error:', reason);
    window.location.reload();
  } else {
    console.warn('[PWA] Suppressed repeated reload for reason:', reason);
  }
}

// Global Chunk Load Error Auto-Recovery (only for genuine dynamic import chunk failures)
window.addEventListener('error', (event) => {
  const msg = event.message || '';
  if (msg.includes('Loading chunk') || msg.includes('dynamically imported module')) {
    safeReloadOnce(msg);
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason ? (event.reason.message || String(event.reason)) : '';
  if (reason.includes('RESOURCE_EXHAUSTED') || reason.includes('Write stream exhausted') || reason.includes('queued writes')) {
    event.preventDefault();
    console.warn('[Firestore] Suppressed background write stream rejection:', reason);
    return;
  }
  if (reason.includes('Loading chunk') || reason.includes('dynamically imported module')) {
    safeReloadOnce(reason);
  }
});

// Register single unified Service Worker for PWA & Push Notifications
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Register single consolidated entrypoint that handles both FCM and offline PWA caching
    navigator.serviceWorker.register('/firebase-messaging-sw.js')
      .then((registration) => {
        console.log('[PWA] Unified Service Worker registered successfully with scope:', registration.scope);
      })
      .catch((error) => {
        console.error('[PWA] Unified Service Worker registration failed:', error);
      });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);


