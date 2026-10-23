// rastertrace service worker: the app is fully static and client-side,
// so offline is just caching. Assets are immutable (cache-busted with
// ?v=NN), navigations and package.json are network-first so updates
// still land on the next online load.
const CACHE = "rastertrace-v5";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("rastertrace-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
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
  // Never cache an HTML body under an asset URL: the host serves
  // index.html with a 200 for paths that do not exist yet, so a request
  // racing a deploy would otherwise pin that fallback page under a
  // script URL forever and break every later load.
  const isHtmlFallback = (response.headers.get("content-type") || "").includes("text/html");
  if (response.ok && !isHtmlFallback) {
    await cache.put(request, response.clone());
    const url = new URL(request.url);
    const version = url.searchParams.get("v");
    if (version && /^\d+$/.test(version)) {
      const staleEntries = [];
      for (const cached of await cache.keys()) {
        const cachedUrl = new URL(cached.url);
        const cachedVersion = cachedUrl.searchParams.get("v");
        // An older response may finish last, so only newer versions evict older ones.
        if (
          cachedUrl.pathname === url.pathname &&
          cachedVersion &&
          /^\d+$/.test(cachedVersion) &&
          BigInt(cachedVersion) < BigInt(version)
        ) {
          staleEntries.push(cache.delete(cached));
        }
      }
      await Promise.all(staleEntries);
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
