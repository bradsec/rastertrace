import assert from "node:assert/strict";
import { test } from "node:test";

test("service-worker fetch waits for cache persistence", async () => {
  const original = {
    caches: globalThis.caches,
    fetch: globalThis.fetch,
    location: globalThis.location,
    self: globalThis.self,
  };
  const listeners = {};
  let releaseCache;
  let markCacheStarted;
  const cacheStarted = new Promise((resolve) => {
    markCacheStarted = resolve;
  });
  let cached = false;
  globalThis.location = { origin: "https://example.test" };
  globalThis.self = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    clients: { claim: async () => {} },
    skipWaiting() {},
  };
  globalThis.caches = {
    async open() {
      return {
        async match() {
          return null;
        },
        async put() {
          markCacheStarted();
          await new Promise((resolve) => {
            releaseCache = resolve;
          });
          cached = true;
        },
        async keys() {
          return [];
        },
      };
    },
  };
  globalThis.fetch = async () =>
    new Response("ok", { headers: { "content-type": "application/javascript" } });

  try {
    await import(`../sw.js?test=${Date.now()}`);
    let responsePromise;
    listeners.fetch({
      request: {
        method: "GET",
        mode: "same-origin",
        url: "https://example.test/js/app.js?v=1",
      },
      respondWith(promise) {
        responsePromise = promise;
      },
    });
    let settled = false;
    responsePromise.then(() => {
      settled = true;
    });
    await cacheStarted;
    assert.equal(settled, false);
    releaseCache();
    await responsePromise;
    assert.equal(cached, true);
  } finally {
    Object.assign(globalThis, original);
  }
});
