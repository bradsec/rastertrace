import test from "node:test";
import assert from "node:assert/strict";
import { floodRegion, growMask, maskLoops, unionMasks } from "../js/magicwand.js";
import { applyCleanupActions } from "../js/eraser.js";

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

/** Build RGBA image data from rows of pixel colors. */
function image(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.flat().forEach((pixel, i) => data.set(pixel, i * 4));
  return { width, height, data };
}

function maskFromRows(rows) {
  return {
    width: rows[0].length,
    height: rows.length,
    mask: Uint8Array.from(rows.join("").split(""), (c) => (c === "#" ? 1 : 0)),
  };
}

test("floodRegion selects only the contiguous region of the clicked color", () => {
  const R = RED;
  const B = BLUE;
  const img = image([
    [R, R, B, R],
    [R, R, B, B],
    [B, B, B, R],
  ]);
  const region = floodRegion(img, 0.1, 0.1);
  assert.equal(region.count, 4);
  assert.deepEqual([...region.mask], [1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
});

test("floodRegion does not join diagonal neighbours", () => {
  const img = image([
    [RED, BLUE],
    [BLUE, RED],
  ]);
  assert.equal(floodRegion(img, 0.1, 0.1).count, 1);
});

test("floodRegion returns null on transparent pixels and outside the image", () => {
  const img = image([[CLEAR, RED]]);
  assert.equal(floodRegion(img, 0.1, 0.5), null);
  assert.equal(floodRegion(img, 1.5, 0.5), null);
  assert.equal(floodRegion(null, 0.5, 0.5), null);
});

test("growMask expands a region by one pixel including diagonals", () => {
  const { mask, width, height } = maskFromRows(["...", ".#.", "..."]);
  assert.deepEqual([...growMask(mask, width, height)], [1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test("unionMasks combines two selections", () => {
  assert.deepEqual([...unionMasks(Uint8Array.of(1, 0, 0), Uint8Array.of(0, 0, 1))], [1, 0, 1]);
});

test("maskLoops outlines a block as one normalized rectangle", () => {
  const { mask, width, height } = maskFromRows(["....", ".##.", ".##.", "...."]);
  const loops = maskLoops(mask, width, height);
  assert.equal(loops.length, 1);
  const xs = loops[0].map((p) => p.x).sort();
  const ys = loops[0].map((p) => p.y).sort();
  assert.equal(loops[0].length, 4);
  assert.deepEqual([xs[0], xs.at(-1), ys[0], ys.at(-1)], [0.25, 0.75, 0.25, 0.75]);
});

test("maskLoops keeps holes as separate loops", () => {
  const { mask, width, height } = maskFromRows(["###", "#.#", "###"]);
  assert.equal(maskLoops(mask, width, height).length, 2);
});

test("region cleanup actions render as an even-odd path", () => {
  const svg = '<svg viewBox="0 0 100 100"><path d="M0 0H100V100H0Z" fill="#000"/></svg>';
  const loops = [
    [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 0, y: 0.5 },
    ],
  ];
  const erased = applyCleanupActions(svg, [{ type: "region", loops }]);
  assert.match(erased, /<path d="M0 0L50 0L50 50L0 50Z" fill-rule="evenodd" fill="#000"\/>/);
  const filled = applyCleanupActions(svg, [{ type: "region", loops, mode: "fill", color: "#fff" }]);
  assert.match(filled, /<path d="M0 0L50 0L50 50L0 50Z" fill-rule="evenodd" fill="#fff"\/>/);
});

test("floodRegion tolerance joins perceptually close shades", () => {
  const DARK = [30, 28, 32, 255];
  const DARKER = [36, 33, 38, 255];
  const img = image([[DARK, DARKER, BLUE]]);
  assert.equal(floodRegion(img, 0.1, 0.5).count, 1);
  assert.equal(floodRegion(img, 0.1, 0.5, 0.05).count, 2);
  assert.equal(floodRegion(img, 0.1, 0.5, 0.05).mask[2], 0);
});

test("growMask expands by the requested radius", () => {
  const { mask, width, height } = maskFromRows([".....", ".....", "..#..", ".....", "....."]);
  assert.equal(
    growMask(mask, width, height, 0).reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(
    growMask(mask, width, height, 2).reduce((a, b) => a + b, 0),
    25,
  );
});

/** Lower-left triangle mask: a 1px staircase along the diagonal. */
function triangle(size) {
  const rows = [];
  for (let y = 0; y < size; y++) rows.push("#".repeat(y + 1) + ".".repeat(size - y - 1));
  return maskFromRows(rows);
}

/** Shoelace area of a normalized loop, in pixels for a size x size mask. */
function area(loop, size) {
  let sum = 0;
  loop.forEach((p, i) => {
    const q = loop[(i + 1) % loop.length];
    sum += p.x * size * q.y * size - q.x * size * p.y * size;
  });
  return Math.abs(sum) / 2;
}

test("maskLoops smooth straightens a staircase into few points", () => {
  const { mask, width, height } = triangle(20);
  const [jagged] = maskLoops(mask, width, height);
  const [smooth] = maskLoops(mask, width, height, 3);
  assert.ok(jagged.length > 30, `jagged has ${jagged.length} points`);
  assert.ok(smooth.length < jagged.length / 2, `smooth has ${smooth.length} points`);
  // Every point stays within a pixel of the staircase's diagonal or edges.
  for (const p of smooth) {
    const x = p.x * 20;
    const y = p.y * 20;
    const nearDiagonal = Math.abs(x - y) / Math.SQRT2 < 1;
    // Corners round by up to the smooth radius (3px here).
    const nearEdge = x < 3 || y > 17;
    assert.ok(nearDiagonal || nearEdge, `point ${x},${y} strays`);
  }
});

test("maskLoops smooth keeps long straight edges and most of the area", () => {
  const { mask, width, height } = maskFromRows([
    "............",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    ".##########.",
    "............",
  ]);
  const [loop] = maskLoops(mask, width, height, 2);
  // Rounding corners costs a little area (most on a shape this small);
  // Expand makes up for it.
  assert.ok(area(loop, 12) > 85, `area ${area(loop, 12)}`);
  assert.ok(area(loop, 12) <= 100);
  for (const p of loop) {
    const x = p.x * 12;
    const y = p.y * 12;
    const toEdge = Math.min(Math.abs(x - 1), Math.abs(x - 11), Math.abs(y - 1), Math.abs(y - 11));
    assert.ok(toEdge < 1, `point ${x},${y} leaves the square's edges`);
  }
});

test("maskLoops smooth 0 matches the exact pixel outline", () => {
  const { mask, width, height } = triangle(6);
  assert.deepEqual(maskLoops(mask, width, height, 0), maskLoops(mask, width, height));
});

/** Block whose top edge has 3px tall, 4px wide bumps every 8px. */
function bumpyTop(width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(
      [...Array(width)].map((_, x) => (y >= 4 || (y >= 1 && x % 8 < 4) ? "#" : ".")).join(""),
    );
  }
  return maskFromRows(rows);
}

/** Vertical spread of the top edge, sampled along the path, away from the ends. */
function topSpread(loop, width, height) {
  const ys = [];
  loop.forEach((p, i) => {
    const q = loop[(i + 1) % loop.length];
    for (let k = 0; k <= 20; k++) {
      const x = (p.x + ((q.x - p.x) * k) / 20) * width;
      const y = (p.y + ((q.y - p.y) * k) / 20) * height;
      if (x > 12 && x < width - 12 && y < height / 2) ys.push(y);
    }
  });
  return Math.max(...ys) - Math.min(...ys);
}

test("maskLoops larger smooth values flatten larger bumps", () => {
  const { mask, width, height } = bumpyTop(64, 16);
  const spread = (s) => topSpread(maskLoops(mask, width, height, s)[0], width, height);
  assert.ok(spread(4) < spread(1) - 0.2, `4: ${spread(4)}, 1: ${spread(1)}`);
  assert.ok(spread(8) < spread(4) - 0.2, `8: ${spread(8)}, 4: ${spread(4)}`);
});
