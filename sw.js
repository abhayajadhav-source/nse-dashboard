/**
 * NSE Dashboard — Service Worker
 *
 * Strategy:
 *   - Static shell (HTML, icons, manifest): cache-first → fast loads, works offline
 *   - API calls (everything under /api/* on Render): network-only → always live data,
 *     never serve stale prices/analysis
 *
 * To bust the cache after deploying changes, bump CACHE_VERSION below.
 * Old caches are auto-deleted on the next activation.
 */

const CACHE_VERSION = "v1.0.0";
const STATIC_CACHE = `nse-dash-static-${CACHE_VERSION}`;

// Assets to pre-cache on install. Keep the list small — only the app shell.
// Page-specific resources (CSS, JS) are inline in each HTML, so we don't list them.
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/strategy.html",
  "/position.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

// API base — anything matching this is always fetched fresh, never cached
const API_HOST = "nse-dashboard-api.onrender.com";

// =============================================================================
// INSTALL — pre-cache the shell
// =============================================================================
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // addAll fails if any single asset fails; we use individual adds
      // so a missing icon doesn't break the whole install.
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[SW] Failed to cache ${url}:`, err);
          })
        )
      );
    })
  );
  // Activate immediately — don't wait for the old SW to release pages
  self.skipWaiting();
});

// =============================================================================
// ACTIVATE — clean up old cache versions
// =============================================================================
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith("nse-dash-") && name !== STATIC_CACHE)
          .map((name) => {
            console.log(`[SW] Deleting old cache: ${name}`);
            return caches.delete(name);
          })
      )
    )
  );
  // Take control of all clients (open tabs) immediately
  self.clients.claim();
});

// =============================================================================
// FETCH — route requests by type
// =============================================================================
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GETs — POSTs go straight to network
  if (request.method !== "GET") {
    return;
  }

  // API calls: always network, never cached. If offline, show a clean error.
  if (url.hostname === API_HOST) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({
            error: "offline",
            message: "You appear to be offline. Live market data requires an internet connection.",
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }
        );
      })
    );
    return;
  }

  // Cross-origin font requests (Google Fonts): cache-first with long TTL
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Static assets (same origin): cache-first, fall back to network, fall back to cached root
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Refresh in background so the next load is up-to-date (stale-while-revalidate)
        fetch(request)
          .then((response) => {
            if (response.ok) {
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, response));
            }
          })
          .catch(() => {}); // ignore — we already served from cache
        return cached;
      }

      // Not in cache — fetch from network and cache it
      return fetch(request)
        .then((response) => {
          if (response.ok && request.url.startsWith(self.location.origin)) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Network failed and not cached — if it's a navigation request, serve the shell
          if (request.mode === "navigate") {
            return caches.match("/index.html") || caches.match("/");
          }
        });
    })
  );
});

// =============================================================================
// MESSAGE — allow pages to trigger updates (used by "update available" banner)
// =============================================================================
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
