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
    assert.deepEqual(deleted, ["rastertrace-v4", "rastertrace-v5"]);
  } finally {
    Object.assign(globalThis, original);
  }
});

test("older asset response cannot evict a newer cached version", async () => {
  const original = {
    caches: globalThis.caches,
    fetch: globalThis.fetch,
    location: globalThis.location,
    self: globalThis.self,
  };
  const listeners = {};
  const base = "https://example.test/js/app.js";
  const entries = new Map([
    [`${base}?v=3`, new Response("v3")],
    [`${base}?v=legacy`, new Response("legacy")],
    [base, new Response("unversioned")],
  ]);
  const releases = new Map();
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
        async match(request) {
          return entries.get(request.url);
        },
        async put(request, response) {
          entries.set(request.url, response);
        },
        async keys() {
          return [...entries.keys()].map((url) => ({ url }));
        },
        async delete(request) {
          return entries.delete(request.url);
        },
      };
    },
  };
  globalThis.fetch = (request) =>
    new Promise((resolve) => {
      releases.set(request.url, resolve);
    });

  try {
    await import(`../sw.js?race-test=${Date.now()}`);
    function request(version) {
      let response;
      listeners.fetch({
        request: { method: "GET", mode: "same-origin", url: `${base}?v=${version}` },
        respondWith(promise) {
          response = promise;
        },
      });
      return response;
    }
    const oldResponse = request(4);
    const newResponse = request(5);
    await Promise.resolve();
    await Promise.resolve();
    releases.get(`${base}?v=5`)(new Response("v5"));
    await newResponse;
    releases.get(`${base}?v=4`)(new Response("v4"));
    await oldResponse;
    assert.deepEqual(
      [...entries.keys()].sort(),
      [`${base}?v=4`, `${base}?v=5`, `${base}?v=legacy`, base].sort(),
    );
  } finally {
    Object.assign(globalThis, original);
  }
});
