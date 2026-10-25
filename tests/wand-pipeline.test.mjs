import test from "node:test";
import assert from "node:assert/strict";
import { coarseRegion, finishRegion } from "../js/wand-pipeline.js";
import { floodRegion, growMask, maskLoops, unionMasks } from "../js/magicwand.js";
import { tracePixels } from "../js/raster.js";

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

function image(rows) {
  const width = rows[0].length;
  const height = rows.length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.flat().forEach((pixel, i) => data.set(pixel, i * 4));
  return { width, height, data };
}

function inlineLoops(raster, refined, seeds, tolerance, expand, smooth, sourceWidth) {
  let mask = null;
  let width = 0;
  let height = 0;
  for (const seed of seeds) {
    const region = floodRegion(raster, seed.x, seed.y, tolerance);
    if (!region) continue;
    ({ width, height } = region);
    mask = mask ? unionMasks(mask, region.mask) : region.mask;
  }
  if (!mask) return null;
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  const margin = 2 + Math.ceil((expand * width) / sourceWidth);
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(width, x1 + margin);
  y1 = Math.min(height, y1 + margin);
  const detail = Math.min(8, Math.floor(Math.sqrt(12_000_000 / ((x1 - x0) * (y1 - y0)))));
  if (detail > 1) {
    let refinedMask = null;
    if (refined) {
      for (const seed of seeds) {
        const nx = (seed.x * width - x0) / (x1 - x0);
        const ny = (seed.y * height - y0) / (y1 - y0);
        const region = floodRegion(refined, nx, ny, tolerance);
        if (region) refinedMask = refinedMask ? unionMasks(refinedMask, region.mask) : region.mask;
      }
    }
    if (refinedMask) {
      mask = refinedMask;
      width = refined.width;
      height = refined.height;
    } else {
      x0 = y0 = 0;
      x1 = width;
      y1 = height;
    }
  } else {
    x0 = y0 = 0;
    x1 = width;
    y1 = height;
  }
  const scale = ((width / (x1 - x0)) * raster.width) / sourceWidth;
  const grown = growMask(mask, width, height, tracePixels(expand, scale));
  const loops = maskLoops(grown, width, height, tracePixels(smooth, scale));
  return loops.map((loop) =>
    loop.map((point) => ({
      x: (x0 + point.x * (x1 - x0)) / raster.width,
      y: (y0 + point.y * (y1 - y0)) / raster.height,
    })),
  );
}

const raster = image([
  [CLEAR, BLUE, BLUE, BLUE, BLUE, BLUE, CLEAR],
  [BLUE, RED, RED, BLUE, RED, RED, BLUE],
  [BLUE, RED, RED, BLUE, RED, RED, BLUE],
  [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE],
]);
const seeds = [
  { x: 0.2, y: 0.4 },
  { x: 0.7, y: 0.4 },
];

for (const fixture of [
  { name: "multiple seeds", seeds, expand: 0, smooth: 0, refined: null },
  { name: "expanded selection", seeds: seeds.slice(0, 1), expand: 2, smooth: 0, refined: null },
  { name: "smoothed selection", seeds: seeds.slice(0, 1), expand: 0, smooth: 2, refined: null },
  {
    name: "refined selection",
    seeds,
    expand: 1,
    smooth: 1,
    refined: image([
      [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE],
      [BLUE, RED, RED, BLUE, RED, RED, BLUE],
      [BLUE, RED, RED, BLUE, RED, RED, BLUE],
      [BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE],
    ]),
  },
]) {
  test(`wand pipeline matches inline loops for ${fixture.name}`, () => {
    const { refined, expand, smooth } = fixture;
    const coarse = coarseRegion(raster, fixture.seeds, 0, expand, raster.width);
    assert.ok(coarse);
    assert.deepEqual(
      finishRegion(coarse, refined, fixture.seeds, 0, expand, smooth, raster.width),
      inlineLoops(raster, refined, fixture.seeds, 0, expand, smooth, raster.width),
    );
  });
}

test("wand pipeline keeps the coarse mask when refined pixels have no match", () => {
  const refined = image([
    [CLEAR, CLEAR],
    [CLEAR, CLEAR],
  ]);
  const coarse = coarseRegion(raster, seeds, 0, 0, raster.width);
  assert.deepEqual(
    finishRegion(coarse, refined, seeds, 0, 0, 0, raster.width),
    inlineLoops(raster, refined, seeds, 0, 0, 0, raster.width),
  );
});
