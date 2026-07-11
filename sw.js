// RasterTrace service worker: the app is fully static and client-side,
// so offline is just caching. Assets are immutable (cache-busted with
// ?v=NN), navigations and package.json are network-first so updates
// still land on the next online load.
const CACHE = "rastertrace-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
    // A new ?v= means the old version of the same file is dead weight.
    const url = new URL(request.url);
    if (url.search) {
      for (const cached of await cache.keys()) {
        const cachedUrl = new URL(cached.url);
        if (cachedUrl.pathname === url.pathname && cachedUrl.search !== url.search) {
          cache.delete(cached);
        }
      }
    }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.mode === "navigate" || url.pathname.endsWith("/package.json")) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});
