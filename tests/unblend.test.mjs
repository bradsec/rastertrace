import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceAndRemoveBackground } from "../js/preprocess.js";

const CREAM = [240, 230, 208];
const NAVY = [30, 52, 90];
const ORANGE = [244, 162, 97];
const TEAL = [42, 157, 143];
const RED = [230, 57, 70];

/** Flat shapes on cream, then a box blur: a soft-edged flat illustration. */
function blurredArt(radius) {
  const width = 160;
  const height = 120;
  const flat = new Uint8ClampedArray(width * height * 4);
  const paint = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) flat.set([...rgb, 255], (y * width + x) * 4);
  };
  paint(0, 0, width, height, CREAM);
  paint(20, 40, 140, 70, NAVY);
  paint(0, 0, 40, 20, ORANGE);
  paint(120, 0, 160, 20, TEAL);
  paint(60, 90, 100, 120, RED);
  const data = new Uint8ClampedArray(flat.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0];
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = Math.min(width - 1, Math.max(0, x + dx));
          const sy = Math.min(height - 1, Math.max(0, y + dy));
          const i = (sy * width + sx) * 4;
          for (let c = 0; c < 3; c++) sum[c] += flat[i + c];
          count += 1;
        }
      }
      const o = (y * width + x) * 4;
      data.set([...sum.map((s) => Math.round(s / count)), 255], o);
    }
  }
  return { data, width, height };
}

const key = (data, p) => `${data[p * 4]},${data[p * 4 + 1]},${data[p * 4 + 2]}`;

/** Distinct colors down column x between rows y0 and y1, top to bottom, runs collapsed. */
function columnRuns(img, x, y0, y1) {
  const runs = [];
  for (let y = y0; y < y1; y++) {
    const k = key(img.data, y * img.width + x);
    if (runs.at(-1) !== k) runs.push(k);
  }
  return runs;
}

for (const radius of [2, 4]) {
  test(`a blurred edge splits between its two fills (blur radius ${radius})`, () => {
    const img = blurredArt(radius);
    reduceAndRemoveBackground(img, 5, { transparent: "", seeds: [CREAM, NAVY, ORANGE, TEAL, RED] });
    const cream = CREAM.join(",");
    const navy = NAVY.join(",");
    // Across the navy bar's top and bottom edges: cream, navy, cream only.
    for (const x of [50, 80, 110]) {
      assert.deepEqual(columnRuns(img, x, 25, 85), [cream, navy, cream], `column ${x}`);
    }
    // Into the red block from cream above.
    assert.deepEqual(columnRuns(img, 80, 75, 119), [cream, RED.join(",")]);
  });
}

test("a real outline color between two fills stays", () => {
  const width = 60;
  const height = 60;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = y < 28 ? CREAM : y < 32 ? TEAL : NAVY;
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  }
  const img = { data, width, height };
  // A sixth color forces quantize to remap instead of returning early.
  data.set([...RED, 255], 0);
  reduceAndRemoveBackground(img, 3, { transparent: "", seeds: [CREAM, TEAL, NAVY] });
  assert.deepEqual(columnRuns(img, 30, 20, 40), [CREAM.join(","), TEAL.join(","), NAVY.join(",")]);
});

test("a smooth gradient keeps its middle bands", () => {
  const width = 120;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1);
      data.set(
        [Math.round(20 + 220 * t), Math.round(40 + 180 * t), Math.round(90 + 110 * t), 255],
        (y * width + x) * 4,
      );
    }
  }
  const img = { data, width, height };
  reduceAndRemoveBackground(img, 4, { transparent: "" });
  const runs = new Set();
  for (let x = 0; x < width; x++) runs.add(key(img.data, 3 * width + x));
  assert.equal(runs.size, 4);
});

test("My colors swatches split a blurred edge between its two fills", () => {
  const img = blurredArt(3);
  const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const swatches = [CREAM, NAVY, ORANGE, TEAL, RED].map(hex);
  reduceAndRemoveBackground(img, 5, { transparent: "", swatches });
  assert.deepEqual(
    columnRuns(img, 80, 25, 85),
    [CREAM, NAVY, CREAM].map((c) => c.join(",")),
  );
});
