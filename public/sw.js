importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

const BUILD_VERSION = "v20260918-1633";
const CACHE_NAME = `beerreel-cache-${BUILD_VERSION}`;
const ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/icon.svg"
];

// Deduplication map to prevent double notifications across FCM & SW listeners
const recentlyShownNotifs = new Map();
function shouldShowNotification(notifId) {
  if (!notifId) return true;
  const now = Date.now();
  for (const [id, time] of recentlyShownNotifs.entries()) {
    if (now - time > 30000) recentlyShownNotifs.delete(id);
  }
  if (recentlyShownNotifs.has(notifId)) {
    console.log("[PWA SW] Notification already shown recently for ID:", notifId, "- suppressing duplicate banner.");
    return false;
  }
  recentlyShownNotifs.set(notifId, now);
  return true;
}

// Set once Firebase Messaging's own onBackgroundMessage handler is actually wired up
// below. The raw "push" listener further down uses this - not a guess based on the
// payload's shape - to skip its own display, since FCM's SDK registers its own
// internal "push" listener and every listener on this event fires for every message.
// Without a definitive flag here, both listeners could call showNotification() for
// the same push, which is exactly what was rendering every notification twice.
let fcmBackgroundHandlerActive = false;

// Initialize Firebase in the service worker for FCM support (prevent duplicate app init error)
try {
  if (typeof firebase !== 'undefined' && firebase.apps && !firebase.apps.length) {
    firebase.initializeApp({
      apiKey: "AIzaSyCe30xhpzmQd2wxkAvx-YiPbTxsfe2VuUA",
      authDomain: "utility-wares-84dh4.firebaseapp.com",
      projectId: "utility-wares-84dh4",
      storageBucket: "utility-wares-84dh4.firebasestorage.app",
      messagingSenderId: "300733292627",
      appId: "1:300733292627:web:1c0bccf5774f97828826a6"
    });
  }

  if (typeof firebase !== 'undefined' && firebase.messaging) {
    const messaging = firebase.messaging();
    fcmBackgroundHandlerActive = true;
    messaging.onBackgroundMessage((payload) => {
      console.log("[PWA SW] FCM Background message received:", payload);
      const title = payload.notification?.title || payload.data?.title || "🍻 Pint Alert";
      const body = payload.notification?.body || payload.data?.body || "A cold beer was logged!";
      const notifId = payload.data?.notificationId || payload.data?.id || payload.notification?.tag || "beerreel-notif-" + (payload.data?.timestamp || Date.now());
      
      if (!shouldShowNotification(notifId)) {
        return;
      }

      const options = {
        body: body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: notifId,
        renotify: false,
        vibrate: [100, 50, 100],
        data: payload.data || {}
      };
      self.registration.showNotification(title, options);
    });
  }
} catch (e) {
  console.warn("[PWA SW] Firebase Messaging init skipped or unavailable in SW:", e);
}

// Install: pre-cache core assets and force immediate skipWaiting
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[PWA SW] Pre-caching core assets for version:", BUILD_VERSION);
      return cache.addAll(ASSETS);
    }).catch((err) => {
      console.warn("[PWA SW] Cache addAll warning:", err);
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches and claim clients immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key.startsWith("beerreel-cache-")) {
            console.log("[PWA SW] Invalidating old cache version:", key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch strategy: Network-First for core shell and asset bundles to guarantee fresh code
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Do not intercept non-GET or non-http(s) requests
  if (event.request.method !== "GET" || !url.protocol.startsWith("http")) {
    return;
  }

  // Do not intercept API endpoints, Firestore, Firebase Auth, Vite dev scripts, or socket connections
  if (
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("firestore") ||
    url.hostname.includes("googleapis") ||
    url.hostname.includes("firebase") ||
    url.pathname.includes("socket") ||
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/@vite") ||
    url.pathname.startsWith("/@fs") ||
    url.search.includes("import")
  ) {
    return;
  }

  const isNavigation = event.request.mode === "navigate";
  const isStaticAsset = url.pathname.match(/\.(js|css|json|svg|png|jpg|jpeg|gif|webp|woff|woff2)$/);

  if (isNavigation || isStaticAsset) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          // If network fetch succeeds with 200 basic response, update cache safely
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache).catch(() => {});
            });
          }
          return networkResponse;
        })
        .catch(async (error) => {
          console.warn("[PWA SW] Network fetch failed, falling back to cache for:", event.request.url, error);
          
          const cachedResponse = await caches.match(event.request);
          if (cachedResponse) {
            return cachedResponse;
          }

          // If navigation fails completely and is uncached, serve root index.html
          if (isNavigation) {
            const rootCache = await caches.match("/");
            if (rootCache) return rootCache;
          }

          throw error;
        })
    );
  } else {
    // Stale-While-Revalidate for other static media
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse).catch(() => {});
              });
            }
          }).catch(() => {});
          return cachedResponse;
        }

        return fetch(event.request).catch((err) => {
          console.error("[PWA SW] Fetch failed for uncached resource:", event.request.url, err);
          if (isNavigation) {
            return caches.match("/");
          }
        });
      })
    );
  }
});

// Handle SKIP_WAITING and message dispatch
self.addEventListener("message", (event) => {
  if (event.data) {
    if (event.data.type === "SKIP_WAITING") {
      self.skipWaiting();
    } else if (event.data.type === "SHOW_NOTIFICATION") {
      const { title, options } = event.data;
      event.waitUntil(
        self.registration.showNotification(title, {
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          vibrate: [100, 50, 100],
          tag: "beerreel-notification",
          renotify: true,
          ...options
        })
      );
    }
  }
});

// Fallback handler for the plain Web Push Protocol, for when FCM's own SW support
// isn't available in this browser/context. Every "push" listener registered on a
// service worker fires for every message, so this must not run at all when FCM's
// onBackgroundMessage handler above is already live - otherwise both fire and every
// notification renders twice.
self.addEventListener("push", (event) => {
  if (fcmBackgroundHandlerActive) {
    return;
  }

  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: "BeerReel Alert! 🍻", body: event.data.text() };
    }
  }

  const notifObj = data.notification || {};
  const dataObj = data.data || data;

  const title = notifObj.title || dataObj.title || data.title || "🍻 Pint Alert";
  const body = notifObj.body || dataObj.body || data.body || "A cold beer is calling your name! 🍻";
  const notifId = dataObj.notificationId || dataObj.id || data.tag || "beerreel-notif-static";

  if (!shouldShowNotification(notifId)) {
    return;
  }

  const options = {
    body: body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [100, 50, 100],
    tag: notifId,
    renotify: false,
    data: dataObj
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Focus or open app window on clicking notification
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      if (clientList.length > 0) {
        let client = clientList[0];
        for (let i = 0; i < clientList.length; i++) {
          if (clientList[i].focused) {
            client = clientList[i];
            break;
          }
        }
        return client.focus();
      }
      return clients.openWindow("/");
    })
  );
});
