/*
 * Minimal service worker: the app is server-first, so nothing is cached except
 * a standalone offline placeholder. It exists so the app is installable and so
 * an offline reload shows a clear message instead of the browser's error page.
 *
 * Bump CACHE when the placeholder changes; the server serves this file
 * `no-cache`, so browsers pick up a new worker on the next load.
 */
const CACHE = "opalnote-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Everything else (API, hashed assets, plugin bundles) stays network-only:
  // notes are canonical on the server and stale JavaScript would be worse than
  // an error page.
  if (request.method !== "GET" || request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (error) {
        const cache = await caches.open(CACHE);
        const fallback = await cache.match(OFFLINE_URL);
        if (fallback) return fallback;
        return new Response("OpalNote is offline.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    })(),
  );
});
