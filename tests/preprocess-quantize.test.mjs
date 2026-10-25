import { test } from "node:test";
import assert from "node:assert/strict";
import { oklabToSrgb, parseHexColor, srgbToOklab, toHexColor } from "../js/color.js";
import { analyzeFlatness, quantize } from "../js/preprocess.js";

test("quantize preserves eight flat colors despite rare edge blends", () => {
  const runs = [
    ["#9AD0EC", 41212],
    ["#FFCF3F", 7336],
    ["#FFFFFF", 9200],
    ["#5B7A99", 18286],
    ["#6BBF59", 15273],
    ["#4C9A3F", 14453],
    ["#DC5540", 9398],
    ["#8C2F2B", 7722],
    ["#97D0F1", 3],
  ];
  const width = runs.reduce((total, [, count]) => total + count, 0);
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  const img = { width, height: 1, data };
  const repeat = { ...img, data: new Uint8ClampedArray(data) };
  quantize(img, 8);
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const hex = toHexColor(data.subarray(i, i + 3));
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  assert.equal(counts.size, 8);
  const palette = [...counts.keys()].map((hex) => srgbToOklab(parseHexColor(hex)));
  for (const [hex] of runs.slice(0, 8)) {
    const lab = srgbToOklab(parseHexColor(hex));
    const distance = Math.min(...palette.map((p) => Math.hypot(...p.map((v, c) => v - lab[c]))));
    assert.ok(distance < 0.01, `${hex} missing from palette: Oklab distance ${distance}`);
  }
  for (const [hex, count] of counts) assert.ok(count >= 10, `${hex} covers only ${count} pixels`);
  quantize(repeat, 8);
  assert.deepEqual(repeat.data, data);
});

test("quantize keeps a small solid accent over anti-alias blends in flat art", () => {
  // Navy and cream with a 2% ramp of blends between them (each blend
  // rare) and a 0.5% red accent: the three most common colors cover
  // 98%, so each keeps a palette slot and the blends map to them.
  const runs = [
    ["#F2E8CF", 6000],
    ["#1D3557", 3550],
    ["#E53946", 50],
  ];
  const width = 10_000;
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  const [r0, g0, b0] = parseHexColor("#F2E8CF");
  const [r1, g1, b1] = parseHexColor("#1D3557");
  for (let i = 0; i < 400; i++, offset += 4) {
    const t = (i + 0.5) / 400;
    data.set([r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t, 255], offset);
  }
  quantize({ width, height: 1, data }, 3);
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  const palette = [...output].map((hex) => srgbToOklab(parseHexColor(hex)));
  for (const [hex] of runs) {
    const lab = srgbToOklab(parseHexColor(hex));
    const distance = Math.min(...palette.map((p) => Math.hypot(...p.map((v, c) => v - lab[c]))));
    assert.ok(distance < 0.01, `${hex} missing from palette: Oklab distance ${distance}`);
  }
});

test("quantize gives a near-duplicate blend no slot of its own", () => {
  // Resampling leaves a common blend one step off cream; it outnumbers
  // the green accent but must not take the accent's slot.
  const runs = [
    ["#F4EFE6", 6000],
    ["#13294B", 3500],
    ["#F0EBE2", 400],
    ["#06D6A0", 100],
  ];
  const width = runs.reduce((total, [, count]) => total + count, 0);
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  quantize({ width, height: 1, data }, 3);
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  assert.deepEqual([...output].sort(), ["#06D6A0", "#13294B", "#F4EFE6"]);
});

test("quantize skips flat colors the tracer would merge into a kept one", () => {
  // The chip sample's colors, most common first. #1B2430 is within Merge
  // 67 of #0B1F1A, so with 4 slots it gives way to the green accent,
  // matching distinctColorCount, instead of taking a slot the tracer
  // would merge away.
  const runs = [
    ["#0B1F1A", 7300],
    ["#2A3644", 1260],
    ["#1B2430", 800],
    ["#C9D1D9", 200],
    ["#2FD39A", 170],
  ];
  const width = runs.reduce((total, [, count]) => total + count, 0);
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  quantize({ width, height: 1, data }, 4, { layerDiff: 67 });
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  assert.deepEqual([...output].sort(), ["#0B1F1A", "#2A3644", "#2FD39A", "#C9D1D9"]);
});

test("quantize leaves spare slots empty instead of keeping rare blends", () => {
  // Two flat colors and 20 one-pixel blends (more exact colors than the
  // 8 slots, so quantize runs): the blends map to the flat colors rather
  // than becoming colors of their own.
  const width = 10_000;
  const data = new Uint8ClampedArray(width * 4);
  for (let i = 0; i < width; i++) {
    const rgba = i < 6000 ? [242, 232, 207, 255] : [29, 53, 87, 255];
    data.set(rgba, i * 4);
  }
  for (let i = 0; i < 20; i++) data.set([60 + i * 8, 80 + i * 6, 100 + i * 5, 255], (6000 + i) * 4);
  quantize({ width, height: 1, data }, 8);
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  assert.deepEqual([...output].sort(), ["#1D3557", "#F2E8CF"]);
});

test("quantize uses given seeds as the palette, for compressed flat art", () => {
  // JPEG-like: two flat colors and a small accent, each spread over
  // many near shades, so no exact color is common enough to seed from.
  const width = 10_000;
  const data = new Uint8ClampedArray(width * 4);
  const base = (i) => (i < 6000 ? [242, 232, 207] : i < 9800 ? [29, 53, 87] : [230, 57, 70]);
  for (let i = 0; i < width; i++) {
    const jitter = (i * 7) % 9;
    data.set([...base(i).map((v) => v + jitter), 255], i * 4);
  }
  const seeds = [
    [242, 232, 207],
    [29, 53, 87],
    [230, 57, 70],
  ];
  quantize({ width, height: 1, data }, 3, { seeds });
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  assert.deepEqual([...output].sort(), ["#1D3557", "#E63946", "#F2E8CF"]);
});

/** One row of hex runs: [hex, pixel count]. */
function runsImage(runs) {
  const width = runs.reduce((total, [, count]) => total + count, 0);
  const data = new Uint8ClampedArray(width * 4);
  let offset = 0;
  for (const [hex, count] of runs) {
    const rgba = [...parseHexColor(hex), 255];
    for (let i = 0; i < count; i++, offset += 4) data.set(rgba, offset);
  }
  return { width, height: 1, data };
}

function colorsOf({ data }) {
  const output = new Set();
  for (let i = 0; i < data.length; i += 4) output.add(toHexColor(data.subarray(i, i + 3)));
  return [...output].sort();
}

test("quantize keeps a painted fill color on top of the seeded palette", () => {
  const img = runsImage([
    ["#F2E8CF", 4000],
    ["#1D3557", 3000],
    ["#00FF00", 500],
    ["#808080", 20],
  ]);
  const seeds = [parseHexColor("#F2E8CF"), parseHexColor("#1D3557")];
  quantize(img, 2, { seeds, keep: [parseHexColor("#00FF00")] });
  assert.deepEqual(colorsOf(img), ["#00FF00", "#1D3557", "#F2E8CF"]);
});

test("quantize keeps a painted fill color on a clustered palette", () => {
  const runs = [["#00FF00", 300]];
  for (let v = 0; v < 256; v += 4) runs.push([toHexColor([v, v, 255 - v]), 200]);
  const img = runsImage(runs);
  quantize(img, 4, { keep: [parseHexColor("#00FF00")] });
  const colors = colorsOf(img);
  assert.ok(colors.includes("#00FF00"), colors.join(" "));
  assert.equal(colors.length, 5);
});

/**
 * Flat art like a large AI-made sticker: a dark ground, cream, grey and tan
 * areas with soft (blurred) edges and slight noise, and optionally a small
 * pink accent whose noise spreads it over many quantize bins. The accent
 * covers about 0.08% of the image, under the 0.1% a flat color needs.
 */
function stickerArt({ accent = true } = {}) {
  const width = 600;
  const height = 600;
  const colors = {
    ground: [22, 6, 0],
    cream: [245, 235, 217],
    grey: [76, 81, 86],
    tan: [131, 108, 79],
    pink: [196, 120, 108],
  };
  const paint = (x, y) => {
    if (accent && x >= 300 && x < 317 && y >= 420 && y < 437) return colors.pink;
    if ((x - 300) ** 2 + (y - 260) ** 2 < 170 ** 2) return colors.cream;
    if (x >= 60 && x < 260 && y >= 470 && y < 560) return colors.grey;
    if (x >= 380 && x < 560 && y >= 470 && y < 560) return colors.tan;
    return colors.ground;
  };
  let seed = 11;
  const noise = (amount) => {
    seed = (seed * 16807) % 2147483647;
    return Math.round((seed / 2147483647 - 0.5) * 2 * amount);
  };
  const data = new Uint8ClampedArray(width * height * 4);
  // A 3x3 box average softens every edge into a band of blends, as
  // upscaled and compressed art has.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = paint(x + dx, y + dy);
          for (let k = 0; k < 3; k++) sum[k] += c[k];
        }
      }
      const pinkArea = paint(x, y) === colors.pink;
      const i = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = sum[k] / 9 + noise(pinkArea ? 4 : 2);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const PINK = srgbToOklab([196, 120, 108]);
const labDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Distinct output colors of a reduced image, and its color at (x, y). */
function reduced(img, x, y) {
  const fills = new Set();
  for (let i = 0; i < img.data.length; i += 4) fills.add(toHexColor(img.data.subarray(i, i + 3)));
  const i = (y * img.width + x) * 4;
  return { fills, at: srgbToOklab([...img.data.subarray(i, i + 3)]) };
}

test("quantize keeps a small accent color that stands apart from the rest", () => {
  const img = stickerArt();
  quantize(img, 32, { layerDiff: 12 });
  const { fills, at } = reduced(img, 308, 428);
  assert.ok(labDistance(at, PINK) < 0.03, `accent became ${toHexColor(oklabToSrgb(at))}`);
  assert.equal(fills.size, 5, [...fills].join(" "));
  // Mid blends along the cream disk's edge sit nearer the accent than any
  // fill; they must not trace as slivers of it.
  const accentHex = toHexColor(oklabToSrgb(at));
  let stray = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (x >= 298 && x < 319 && y >= 418 && y < 439) continue;
      const i = (y * img.width + x) * 4;
      if (toHexColor(img.data.subarray(i, i + 3)) === accentHex) stray++;
    }
  }
  assert.equal(stray, 0, `${stray} accent pixels outside the accent`);
});

test("quantize gives soft edge blends no accent slot", () => {
  const img = stickerArt({ accent: false });
  quantize(img, 32, { layerDiff: 12 });
  const { fills } = reduced(img, 0, 0);
  assert.equal(fills.size, 4, [...fills].join(" "));
});

test("analyzeFlatness detects a small accent color that stands apart", () => {
  const { solids } = analyzeFlatness(stickerArt());
  assert.ok(
    solids.some((rgb) => labDistance(srgbToOklab(rgb), PINK) < 0.03),
    solids.map((rgb) => toHexColor(rgb)).join(" "),
  );
  assert.equal(solids.length, 5, solids.map((rgb) => toHexColor(rgb)).join(" "));
  assert.equal(analyzeFlatness(stickerArt({ accent: false })).solids.length, 4);
});
