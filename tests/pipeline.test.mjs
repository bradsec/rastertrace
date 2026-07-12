import { test } from "node:test";
import assert from "node:assert/strict";
import { fitDecodeSize, invertRGBA, sniffImageSize, Tracer } from "../js/pipeline.js";

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

// APP1 Exif segment with a single IFD0 entry: orientation tag 0x0112.
// `little` picks the TIFF byte order (II vs MM).
function exifSegment(orientation, little) {
  const u16 = (v) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v) =>
    little
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
      : [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  return [
    0xff, 0xe1, 0x00, 0x22, // APP1, length 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(0x2a), ...u32(8),
    ...u16(1), // one IFD0 entry
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), ...u16(0),
    ...u32(0), // no next IFD
  ];
}

const JPEG_SOF = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00];

test("sniffImageSize swaps JPEG dimensions for EXIF orientation 6", async () => {
  const bytes = [0xff, 0xd8, ...exifSegment(6, true), ...JPEG_SOF];
  assert.deepEqual(await sniffImageSize(blob(bytes, "image/jpeg")), { width: 800, height: 1280 });
});

test("sniffImageSize swaps JPEG dimensions for big-endian EXIF orientation 8", async () => {
  const bytes = [0xff, 0xd8, ...exifSegment(8, false), ...JPEG_SOF];
  assert.deepEqual(await sniffImageSize(blob(bytes, "image/jpeg")), { width: 800, height: 1280 });
});

test("sniffImageSize keeps JPEG dimensions for EXIF orientation 1", async () => {
  const bytes = [0xff, 0xd8, ...exifSegment(1, true), ...JPEG_SOF];
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

test("invertRGBA inverts RGB and leaves alpha untouched", () => {
  const data = Uint8ClampedArray.from([0, 128, 255, 200]);
  invertRGBA(data);
  assert.deepEqual([...data], [255, 127, 0, 200]);
});

test("invertRGBA over two pixels only touches RGB channels", () => {
  const data = Uint8ClampedArray.from([10, 20, 30, 40, 200, 100, 50, 0]);
  invertRGBA(data);
  assert.deepEqual([...data], [245, 235, 225, 40, 55, 155, 205, 0]);
});

test("invertRGBA applied twice restores the original", () => {
  const original = Uint8ClampedArray.from([1, 50, 200, 255, 99, 0, 17, 128]);
  const data = Uint8ClampedArray.from(original);
  invertRGBA(data);
  invertRGBA(data);
  assert.deepEqual([...data], [...original]);
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
