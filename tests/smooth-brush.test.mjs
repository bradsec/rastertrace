import test from "node:test";
import assert from "node:assert/strict";
import { smoothLabels, smoothOutlines } from "../js/preprocess.js";
import { DEFAULTS, sanitizeSettings } from "../js/settings-schema.js";

const BLUE = [20, 80, 180];
const CREAM = [240, 228, 200];
const GOLD = [240, 200, 120];

/** RGBA image from rows of characters, each mapped to a color (or null). */
function image(rows, colors) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      const color = colors[c];
      if (color) data.set([...color, 255], (y * width + x) * 4);
    }),
  );
  return { width, height, data };
}

const colorAt = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return img.data[i + 3] < 128 ? null : [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** A stroke region covering a disc at (cx, cy) with the given radius. */
function disc(cx, cy, r, radius) {
  const x = cx - r;
  const y = cy - r;
  const size = 2 * r + 1;
  const bits = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if ((i - r) ** 2 + (j - r) ** 2 <= r * r) bits[j * size + i] = 1;
    }
  }
  return { x, y, width: size, height: size, bits, radius };
}

/** Blue above row 30, cream below, with a 6x6 cream notch cut into the blue. */
function notched() {
  const rows = [];
  for (let y = 0; y < 60; y++) {
    let row = "";
    for (let x = 0; x < 80; x++) row += y >= 30 || (y >= 24 && x >= 37 && x < 43) ? "c" : "b";
    rows.push(row);
  }
  return image(rows, { b: BLUE, c: CREAM });
}

test("smoothLabels fills a notch inside the stroke", () => {
  const img = notched();
  smoothLabels(img, [disc(40, 28, 14, 6)]);
  for (let y = 22; y < 29; y++) {
    for (let x = 36; x < 44; x++) assert.deepEqual(colorAt(img, x, y), BLUE, `${x},${y}`);
  }
  // The notch's area spreads along the edge, which stays within a pixel
  // of where it was and meets the untouched edge outside without a step.
  for (let x = 20; x < 60; x++) {
    assert.deepEqual(colorAt(img, x, 28), BLUE, `${x},28`);
    assert.deepEqual(colorAt(img, x, 30), CREAM, `${x},30`);
  }
});

test("smoothLabels leaves pixels outside the stroke alone", () => {
  const img = notched();
  // The stroke misses the notch: it stays.
  smoothLabels(img, [disc(10, 28, 6, 3)]);
  assert.deepEqual(colorAt(img, 40, 26), CREAM);
});

test("smoothLabels adds no colors", () => {
  const rows = [];
  for (let y = 0; y < 40; y++) {
    let row = "";
    for (let x = 0; x < 40; x++) row += y < 20 ? "b" : x < 20 ? "c" : "g";
    rows.push(row);
  }
  const img = image(rows, { b: BLUE, c: CREAM, g: GOLD });
  smoothLabels(img, [disc(20, 20, 12, 5)]);
  const seen = new Set();
  for (let p = 0; p < 40 * 40; p++) seen.add(img.data.slice(p * 4, p * 4 + 3).join(","));
  assert.deepEqual([...seen].sort(), [BLUE, CREAM, GOLD].map((c) => c.join(",")).sort());
});

test("smoothLabels treats transparency as a color", () => {
  // A transparent hole with a one-pixel spur of blue poking into it.
  const rows = [];
  for (let y = 0; y < 40; y++) {
    let row = "";
    for (let x = 0; x < 40; x++) row += y >= 20 && !(x === 20 && y < 24) ? "." : "b";
    rows.push(row);
  }
  const img = image(rows, { b: BLUE });
  smoothLabels(img, [disc(20, 22, 8, 4)]);
  assert.equal(colorAt(img, 20, 22), null);
  assert.deepEqual(colorAt(img, 20, 18), BLUE);
});

test("smoothLabels evens out a stair-stepped diagonal", () => {
  // Blue above a staircase of 6 px steps that should be a straight line.
  const rows = [];
  for (let y = 0; y < 80; y++) {
    let row = "";
    for (let x = 0; x < 80; x++) row += y < 20 + 6 * Math.floor(x / 12) ? "b" : "c";
    rows.push(row);
  }
  const img = image(rows, { b: BLUE, c: CREAM });
  /**
   * Largest gap between the edge and the line through the step middles,
   * where the stroke smooths fully (more than a radius from its edge).
   */
  const wobble = () => {
    let worst = 0;
    for (let x = 30; x < 50; x++) {
      let edge = 0;
      while (edge < 80 && colorAt(img, x, edge)?.[0] === BLUE[0]) edge++;
      worst = Math.max(worst, Math.abs(edge - (17 + x / 2)));
    }
    return worst;
  };
  const before = wobble();
  // Blur radius a quarter of the stroke diameter, as the brush uses.
  smoothLabels(img, [disc(40, 37, 24, 12)]);
  assert.ok(wobble() <= 1, `wobble ${before} -> ${wobble()}`);
});

test("smoothOutlines clears single-pixel steps but keeps a 3 px line", () => {
  // Blue over cream along row 20 with one-pixel bumps every 4 columns,
  // and a 3 px cream line across the blue.
  const rows = [];
  for (let y = 0; y < 40; y++) {
    let row = "";
    for (let x = 0; x < 40; x++) {
      const bump = y === 19 && x % 4 === 0;
      row += y >= 20 || bump || (y >= 6 && y < 9) ? "c" : "b";
    }
    rows.push(row);
  }
  const img = image(rows, { b: BLUE, c: CREAM });
  smoothOutlines(img, 1);
  for (let x = 2; x < 38; x++) {
    assert.deepEqual(colorAt(img, x, 19), BLUE, `bump at ${x}`);
    assert.deepEqual(colorAt(img, x, 7), CREAM, `line at ${x}`);
  }
});

test("smooth outlines setting defaults on and validates", () => {
  assert.equal(DEFAULTS.smoothOutlines, 1);
  assert.deepEqual(sanitizeSettings({ smoothOutlines: 3 }), { smoothOutlines: 3 });
  assert.deepEqual(sanitizeSettings({ smoothOutlines: 5 }), {});
  assert.deepEqual(sanitizeSettings({ smoothOutlines: 1.5 }), {});
});
