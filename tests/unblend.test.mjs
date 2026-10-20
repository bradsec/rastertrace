import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeFlatness, reduceAndRemoveBackground } from "../js/preprocess.js";

const CREAM = [240, 230, 208];
const NAVY = [30, 52, 90];
const ORANGE = [244, 162, 97];
const TEAL = [42, 157, 143];
const RED = [230, 57, 70];

/** Flat shapes on cream, then a box blur: a soft-edged flat illustration. */
function blurredArt(radius, { teal = true, red = true } = {}) {
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
  if (teal) paint(120, 0, 160, 20, TEAL);
  if (red) paint(60, 90, 100, 120, RED);
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

test("My colors swatches that differ from the art still split a blurred edge", () => {
  const img = blurredArt(3);
  // Each swatch sits well away from the art color it stands for.
  const swatches = ["#ffffff", "#000050", "#ff8000", "#00a0a0", "#ff0000"];
  reduceAndRemoveBackground(img, 5, { transparent: "", swatches });
  assert.deepEqual(columnRuns(img, 80, 25, 85), ["255,255,255", "0,0,80", "255,255,255"]);
});

for (const radius of [1, 2, 4, 6]) {
  test(`auto-detect finds only the fills of blurred art (blur radius ${radius})`, () => {
    const { flat, colorCount, solids } = analyzeFlatness(blurredArt(radius));
    assert.equal(flat, true);
    assert.equal(colorCount, 5, JSON.stringify(solids));
    for (const fill of [CREAM, NAVY, ORANGE, TEAL, RED]) {
      assert.ok(
        solids.some((s) => s.every((v, c) => Math.abs(v - fill[c]) <= 3)),
        `${fill} in ${JSON.stringify(solids)}`,
      );
    }
  });
}

test("auto-detect keeps a real stripe whose color sits between its neighbors", () => {
  const width = 90;
  const height = 60;
  const data = new Uint8ClampedArray(width * height * 4);
  const MID = [135, 141, 149];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = x < 40 ? CREAM : x < 48 ? MID : NAVY;
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  }
  const { colorCount } = analyzeFlatness({ data, width, height });
  assert.equal(colorCount, 3);
});

test("soft edges split on noisy flat art with a manual color count", () => {
  // Cream, navy and orange only, so three colors find the three fills.
  const img = blurredArt(3, { teal: false, red: false });
  // JPEG-like noise: no exact colors for the quantizer to seed from.
  for (let p = 0; p < img.width * img.height; p++) {
    const noise = ((p * 7919) % 13) - 6;
    for (let c = 0; c < 3; c++) img.data[p * 4 + c] += noise;
  }
  reduceAndRemoveBackground(img, 3, { transparent: "", flatArt: true });
  const at = (x, y) => key(img.data, y * img.width + x);
  const cream = at(80, 10);
  const navy = at(80, 55);
  for (const x of [50, 80, 110]) {
    assert.deepEqual(columnRuns(img, x, 25, 85), [cream, navy, cream], `column ${x}`);
  }
});

test("noisy fills still split a soft edge near a third fill", () => {
  // Gold over navy with a peach corner: a gold and navy blend near the
  // gold end passes close to peach. Noise inside the fills must not break
  // them into specks that stop counting as fills.
  const GOLD = [246, 210, 122];
  const INK = [4, 4, 92];
  const PEACH = [233, 164, 109];
  const width = 200;
  const height = 120;
  const flat = (x, y) => (x < 40 && y < 20 ? PEACH : y < 60 + (x >> 3) ? GOLD : INK);
  const data = new Uint8ClampedArray(width * height * 4);
  const radius = 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0];
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const c = flat(
            Math.min(width - 1, Math.max(0, x + dx)),
            Math.min(height - 1, Math.max(0, y + dy)),
          );
          for (let k = 0; k < 3; k++) sum[k] += c[k];
          count += 1;
        }
      }
      const p = y * width + x;
      const noise = ((p * 7919) % 17) - 8;
      data.set([...sum.map((s) => Math.round(s / count) + noise), 255], p * 4);
    }
  }
  const img = { data, width, height };
  // Scale 2, the reference upscale, as flat art is traced upscaled.
  reduceAndRemoveBackground(img, 3, { transparent: "", seeds: [GOLD, INK, PEACH], scale: 2 });
  let stray = 0;
  for (let y = 40; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (key(img.data, y * width + x) === PEACH.join(",")) stray += 1;
    }
  }
  assert.equal(stray, 0);
});
