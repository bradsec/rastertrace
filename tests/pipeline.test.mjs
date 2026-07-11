import { test } from "node:test";
import assert from "node:assert/strict";
import { fitDecodeSize, sniffImageSize, Tracer } from "../js/pipeline.js";

function blob(bytes, type = "image/png") {
  return new Blob([Uint8Array.from(bytes)], { type });
}

test("sniffImageSize reads PNG dimensions without decoding pixels", async () => {
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0x10, 0, 0, 0, 0x08, 0,
  ];
  assert.deepEqual(await sniffImageSize(blob(bytes)), { width: 4096, height: 2048 });
});

test("sniffImageSize reads JPEG dimensions from SOF marker", async () => {
  const bytes = [
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00,
  ];
  assert.deepEqual(await sniffImageSize(blob(bytes, "image/jpeg")), { width: 1280, height: 800 });
});

test("sniffImageSize reads WebP VP8X dimensions", async () => {
  const bytes = [
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58,
    0, 0, 0, 0, 0, 0, 0, 0,
    0xff, 0x03, 0x00,
    0xff, 0x01, 0x00,
  ];
  assert.deepEqual(await sniffImageSize(blob(bytes, "image/webp")), { width: 1024, height: 512 });
});

test("fitDecodeSize caps the longest side", () => {
  assert.deepEqual(fitDecodeSize(4032, 3024, 2048), { width: 2048, height: 1536 });
  assert.deepEqual(fitDecodeSize(100, 50, 2048), { width: 100, height: 50 });
});

test("Tracer cancels stale worker work before posting the next trace", async () => {
  const OriginalWorker = globalThis.Worker;
  const workers = [];
  class FakeWorker {
    constructor() {
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) {
      this.message = message;
    }
    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = FakeWorker;
  try {
    const tracer = new Tracer("worker.js");
    const imageData = { data: new Uint8ClampedArray([1, 2, 3, 4]), width: 1, height: 1 };
    const stale = tracer.trace(imageData, {}, 1, 1);
    const latest = tracer.trace(imageData, {}, 1, 1);
    assert.equal(await stale, null);
    assert.equal(workers[0].terminated, true);
    workers[1].onmessage({ data: { id: workers[1].message.id, svg: "<svg></svg>", ms: 1 } });
    assert.deepEqual(await latest, { id: 1, svg: "<svg></svg>", ms: 1 });
  } finally {
    globalThis.Worker = OriginalWorker;
  }
});
