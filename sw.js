const SHELL_CACHE = "canopyquest-shell-v12";
const DATA_CACHE = "canopyquest-data-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=3.3.0",
  "./database-config.js?v=3.3.0",
  "./ai-provider.js?v=3.3.0",
  "./app.js?v=3.3.0",
  "./scanner-bg.jpg",
  "./manifest.webmanifest"
];

self.addEventListener("install", event => {
  event.waitUntil(Promise.all([
    caches.open(SHELL_CACHE).then(cache => cache.addAll(APP_SHELL)),
    self.skipWaiting()
  ]));
});

self.addEventListener("activate", event => {
  const currentCaches = new Set([SHELL_CACHE, DATA_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith("canopyquest-") && !currentCaches.has(key))
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function staleWhileRevalidate(event, cacheName, cacheKey = event.request) {
  const network = fetch(event.request).then(response => {
    if (response.ok || response.type === "opaque") {
      const copy = response.clone();
      return caches.open(cacheName).then(cache => cache.put(cacheKey, copy)).then(() => response);
    }
    return response;
  });
  event.waitUntil(network.catch(() => null));
  return caches.match(cacheKey).then(cached => cached || network);
}

function cacheFirst(event, cacheName) {
  return caches.match(event.request).then(cached => {
    if (cached) return cached;
    return fetch(event.request).then(response => {
      if (response.ok || response.type === "opaque") {
        const copy = response.clone();
        return caches.open(cacheName).then(cache => cache.put(event.request, copy)).then(() => response);
      }
      return response;
    });
  });
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);

  if (event.request.mode === "navigate") {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, "./index.html")
      .catch(() => caches.match("./index.html")));
    return;
  }

  if (
    requestUrl.hostname === "tigerweb.geo.census.gov"
    || (requestUrl.origin === "https://orange-tree-database.vercel.app" && requestUrl.pathname === "/v1/trees")
  ) {
    if (requestUrl.searchParams.has("refresh")) {
      event.respondWith(fetch(event.request));
      return;
    }
    event.respondWith(staleWhileRevalidate(event, DATA_CACHE)
      .catch(() => new Response(JSON.stringify({ offline: true }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      })));
    return;
  }

  if (requestUrl.hostname === "fonts.googleapis.com" || requestUrl.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(event, DATA_CACHE));
    return;
  }

  if (requestUrl.origin === self.location.origin) {
    event.respondWith(cacheFirst(event, SHELL_CACHE));
  }
});
