import test from "node:test";
import assert from "node:assert/strict";
import { smoothAlpha } from "../js/preprocess.js";
import { DEFAULTS, sanitizeSettings } from "../js/settings-schema.js";

const RED = [200, 30, 30];

/** RGBA image from rows of "#" (opaque red) and "." (transparent). */
function image(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === "#") data.set([...RED, 255], (y * width + x) * 4);
    }),
  );
  return { width, height, data };
}

const opaque = (img, x, y) => img.data[(y * img.width + x) * 4 + 3] >= 128;

/** Topmost opaque row in each column. */
function topRows(img) {
  return [...Array(img.width)].map((_, x) => {
    for (let y = 0; y < img.height; y++) if (opaque(img, x, y)) return y;
    return img.height;
  });
}

/** Block whose top edge has 3px tall, 4px wide bumps every 8px. */
function bumpy() {
  const rows = [];
  for (let y = 0; y < 20; y++) {
    rows.push([...Array(48)].map((_, x) => (y >= 8 || (y >= 5 && x % 8 < 4) ? "#" : ".")).join(""));
  }
  return image(rows);
}

test("smoothAlpha flattens bumps narrower than the radius", () => {
  const img = smoothAlpha(bumpy(), 4);
  const tops = topRows(img).slice(8, -8);
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, `tops ${tops.join(",")}`);
});

test("smoothAlpha leaves a smaller radius closer to the original", () => {
  const spread = (r) => {
    const tops = topRows(smoothAlpha(bumpy(), r)).slice(8, -8);
    return Math.max(...tops) - Math.min(...tops);
  };
  assert.ok(spread(1) > spread(4), `1: ${spread(1)}, 4: ${spread(4)}`);
});

test("smoothAlpha keeps straight edges and the canvas border in place", () => {
  const rows = [...Array(16)].map((_, y) => (y < 6 ? ".".repeat(16) : "#".repeat(16)));
  const img = smoothAlpha(image(rows), 3);
  assert.deepEqual(topRows(img), Array(16).fill(6));
  assert.ok(opaque(img, 0, 15) && opaque(img, 15, 15), "border pixels stay opaque");
});

test("smoothAlpha colors newly opaque pixels from their opaque neighbours", () => {
  const img = smoothAlpha(bumpy(), 4);
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3] < 128) continue;
    assert.deepEqual([...img.data.slice(i * 4, i * 4 + 3)], RED);
  }
});

test("smoothAlpha with radius 0 changes nothing", () => {
  const before = bumpy();
  const after = smoothAlpha(bumpy(), 0);
  assert.deepEqual([...after.data], [...before.data]);
});

test("edgeSmooth setting defaults to off and validates its range", () => {
  assert.equal(DEFAULTS.edgeSmooth, 0);
  assert.equal(sanitizeSettings({ edgeSmooth: 6 }).edgeSmooth, 6);
  assert.equal(sanitizeSettings({ edgeSmooth: 99 }).edgeSmooth, undefined);
});
