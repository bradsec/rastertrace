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

test("service-worker activation preserves caches owned by sibling applications", async () => {
  const original = {
    caches: globalThis.caches,
    self: globalThis.self,
  };
  const listeners = {};
  const deleted = [];
  let activation;
  globalThis.self = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    clients: { claim: async () => {} },
    skipWaiting() {},
  };
  globalThis.caches = {
    async delete(key) {
      deleted.push(key);
    },
    async keys() {
      return ["rastertrace-v4", "rastertrace-v5", "sibling-app-v1"];
    },
  };

  try {
    await import(`../sw.js?activation-test=${Date.now()}`);
    listeners.activate({
      waitUntil(promise) {
        activation = promise;
      },
    });
    await activation;
    assert.deepEqual(deleted, ["rastertrace-v4"]);
  } finally {
    Object.assign(globalThis, original);
  }
});
