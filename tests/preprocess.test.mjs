import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeFlatness,
  assertRasterBudget,
  DEFAULTS,
  MAX_TRACE_PIXELS,
  binarizeAlpha,
  countPaths,
  defringeAlpha,
  detectBackgroundColor,
  dominantOpaqueColor,
  erodeAlpha,
  finalizeSvg,
  fitTraceScale,
  MAX_TRACE_SIDE,
  knockOutColor,
  medianFilter,
  modeFilter,
  oklabToSrgb,
  parseHexColor,
  quantize,
  srgbToOklab,
  removeBackground,
  resolveSettings,
  snapToImageColor,
  toGrayscale,
  toHexColor,
} from "../js/preprocess.js";

function makeImage(width, height, fill = [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { data, width, height };
}

function setPixel(img, x, y, rgba) {
  img.data.set(rgba, (y * img.width + x) * 4);
}

function getPixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [...img.data.slice(i, i + 4)];
}

test("parseHexColor accepts #RRGGBB and RRGGBB", () => {
  assert.deepEqual(parseHexColor("#FFAA00"), [255, 170, 0]);
  assert.deepEqual(parseHexColor("ffaa00"), [255, 170, 0]);
  assert.equal(parseHexColor("notacolor"), null);
  assert.equal(parseHexColor("#FFF"), null);
});

test("toHexColor round-trips", () => {
  assert.equal(toHexColor([17, 25, 15]), "#11190F");
  assert.deepEqual(parseHexColor(toHexColor([1, 2, 3])), [1, 2, 3]);
});

test("detectBackgroundColor picks most common opaque corner", () => {
  const img = makeImage(4, 4, [10, 20, 30, 255]);
  setPixel(img, 3, 3, [200, 0, 0, 255]);
  assert.deepEqual(detectBackgroundColor(img), [10, 20, 30]);
});

test("detectBackgroundColor returns null for transparent corners", () => {
  const img = makeImage(4, 4, [10, 20, 30, 0]);
  assert.equal(detectBackgroundColor(img), null);
});

test("detectBackgroundColor survives a corner artifact", () => {
  // JPEG-noisy background: every corner pixel differs slightly and one
  // corner holds a watermark-like artifact. Sampling only the 4 corner
  // pixels picks the artifact; patch + border sampling must not.
  const img = makeImage(12, 12, [10, 20, 30, 255]);
  setPixel(img, 11, 0, [11, 21, 29, 255]);
  setPixel(img, 0, 11, [9, 19, 31, 255]);
  setPixel(img, 11, 11, [12, 19, 30, 255]);
  setPixel(img, 0, 0, [40, 60, 80, 255]); // artifact
  const detected = detectBackgroundColor(img);
  assert.ok(detected, "expected a detection");
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(detected[c] - [10, 20, 30][c]) <= 4, `channel ${c}: ${detected}`);
  }
});

test("detectBackgroundColor returns null when the border is mostly transparent", () => {
  // Subject touches one corner of an otherwise transparent canvas: that
  // corner color is the subject, not a background to remove.
  const img = makeImage(10, 10, [0, 0, 0, 0]);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) setPixel(img, x, y, [200, 40, 40, 255]);
  }
  assert.equal(detectBackgroundColor(img), null);
});

test("knockOutColor zeroes alpha within fuzz only", () => {
  const img = makeImage(2, 1, [100, 100, 100, 255]);
  setPixel(img, 1, 0, [130, 100, 100, 255]);
  knockOutColor(img, [100, 100, 100], 16);
  assert.equal(getPixel(img, 0, 0)[3], 0); // exact match removed
  assert.equal(getPixel(img, 1, 0)[3], 255); // hue shift beyond fuzz, kept
});

test("knockOutColor fuzz is perceptual: catches lightness noise, spares hue shifts", () => {
  // White background with a light JPEG shadow: per-channel distance 20
  // misses it at fuzz 16, but perceptually it is background.
  const img = makeImage(2, 1, [255, 255, 255, 255]);
  setPixel(img, 1, 0, [235, 235, 235, 255]);
  knockOutColor(img, [255, 255, 255], 16);
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 1, 0)[3], 0); // shadow removed with the background
});

test("binarizeAlpha thresholds at 128", () => {
  const img = makeImage(3, 1);
  setPixel(img, 0, 0, [0, 0, 0, 127]);
  setPixel(img, 1, 0, [0, 0, 0, 128]);
  setPixel(img, 2, 0, [0, 0, 0, 255]);
  binarizeAlpha(img);
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 1, 0)[3], 255);
  assert.equal(getPixel(img, 2, 0)[3], 255);
});

test("toGrayscale preserves alpha", () => {
  const img = makeImage(1, 1, [255, 0, 0, 200]);
  toGrayscale(img);
  const [r, g, b, a] = getPixel(img, 0, 0);
  assert.equal(r, g);
  assert.equal(g, b);
  assert.equal(a, 200);
});

test("dominantOpaqueColor ignores transparent pixels", () => {
  const img = makeImage(4, 1, [9, 9, 9, 0]);
  setPixel(img, 0, 0, [50, 60, 70, 255]);
  assert.deepEqual(dominantOpaqueColor(img), [50, 60, 70]);
});

test("dominantOpaqueColor falls back to white when fully transparent", () => {
  const img = makeImage(2, 2, [9, 9, 9, 0]);
  assert.deepEqual(dominantOpaqueColor(img), [255, 255, 255]);
});

test("srgbToOklab/oklabToSrgb round-trip within 1 per channel", () => {
  const samples = [
    [0, 0, 0],
    [255, 255, 255],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [30, 30, 120],
    [255, 240, 80],
    [200, 120, 40],
  ];
  for (const rgb of samples) {
    const back = oklabToSrgb(srgbToOklab(rgb));
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(back[c] - rgb[c]) <= 1, `${rgb} -> ${back}`);
    }
  }
});

test("srgbToOklab orders grays by lightness with near-zero chroma", () => {
  const dark = srgbToOklab([40, 40, 40]);
  const light = srgbToOklab([220, 220, 220]);
  assert.ok(light[0] > dark[0]);
  for (const lab of [dark, light]) {
    assert.ok(Math.abs(lab[1]) < 0.001 && Math.abs(lab[2]) < 0.001, `chroma ${lab}`);
  }
});

test("quantize to 2 keeps navy and yellow hues distinct", () => {
  // Half navy shades, half yellow shades: the two palette entries must
  // land on opposite hues rather than merging into muddy midpoints.
  const img = makeImage(8, 2);
  for (let x = 0; x < 8; x++) {
    setPixel(img, x, 0, [28 + x, 30, 118 + x * 2, 255]);
    setPixel(img, x, 1, [250 - x, 238, 78 + x, 255]);
  }
  quantize(img, 2);
  const top = getPixel(img, 0, 0);
  const bottom = getPixel(img, 0, 1);
  assert.ok(top[2] > top[0], `navy stayed blue-ish: ${top}`);
  assert.ok(bottom[0] > bottom[2], `yellow stayed warm: ${bottom}`);
});

test("quantize reduces distinct colors and leaves alpha untouched", () => {
  const img = makeImage(16, 1);
  for (let x = 0; x < 16; x++) setPixel(img, x, 0, [x * 16, 255 - x * 16, 128, 255]);
  quantize(img, 4);
  const unique = new Set();
  for (let x = 0; x < 16; x++) {
    const [r, g, b, a] = getPixel(img, x, 0);
    unique.add(`${r},${g},${b}`);
    assert.equal(a, 255);
  }
  assert.ok(unique.size <= 4, `expected <= 4 colors, got ${unique.size}`);
});

test("quantize backfills transparent pixels so they do not skew the palette", () => {
  // 1 opaque red pixel + 63 transparent garbage-black pixels.
  const img = makeImage(8, 8, [1, 2, 0, 0]);
  setPixel(img, 4, 4, [255, 0, 0, 255]);
  quantize(img, 2);
  const [r, g, b] = getPixel(img, 4, 4);
  assert.deepEqual([r, g, b], [255, 0, 0]);
});

test("quantize is a no-op when colors already fit", () => {
  const img = makeImage(2, 1, [10, 20, 30, 255]);
  const before = [...img.data];
  quantize(img, 8);
  assert.deepEqual([...img.data], before);
});

test("medianFilter removes single-pixel noise", () => {
  const img = makeImage(5, 5, [100, 100, 100, 255]);
  setPixel(img, 2, 2, [255, 0, 0, 255]); // salt noise
  medianFilter(img);
  assert.deepEqual(getPixel(img, 2, 2).slice(0, 3), [100, 100, 100]);
});

test("medianFilter preserves hard edges", () => {
  // Left half black, right half white: a box blur would gray the
  // boundary columns; the median must keep both sides exact.
  const img = makeImage(6, 6);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) setPixel(img, x, y, x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  }
  medianFilter(img);
  for (let y = 0; y < 6; y++) {
    assert.deepEqual(getPixel(img, 2, y).slice(0, 3), [0, 0, 0]);
    assert.deepEqual(getPixel(img, 3, y).slice(0, 3), [255, 255, 255]);
  }
});

test("medianFilter leaves alpha untouched and skips transparent neighbors", () => {
  const img = makeImage(3, 3, [40, 40, 40, 0]);
  setPixel(img, 1, 1, [200, 10, 10, 255]); // lone opaque pixel
  medianFilter(img);
  assert.deepEqual(getPixel(img, 1, 1), [200, 10, 10, 255]); // only itself in window
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.deepEqual(getPixel(img, 0, 0).slice(0, 3), [40, 40, 40]); // transparent RGB untouched
});

test("modeFilter removes isolated speck, keeps solid regions", () => {
  const img = makeImage(5, 5, [10, 10, 10, 255]);
  setPixel(img, 2, 2, [200, 0, 0, 255]); // lone speck
  modeFilter(img);
  assert.deepEqual(getPixel(img, 2, 2).slice(0, 3), [10, 10, 10]);
  assert.deepEqual(getPixel(img, 0, 0).slice(0, 3), [10, 10, 10]);
});

test("modeFilter ignores transparent pixels and preserves alpha", () => {
  const img = makeImage(3, 3, [10, 10, 10, 0]);
  setPixel(img, 1, 1, [200, 0, 0, 255]);
  modeFilter(img);
  // Lone opaque pixel has no opaque majority around it: unchanged.
  assert.deepEqual(getPixel(img, 1, 1), [200, 0, 0, 255]);
  assert.equal(getPixel(img, 0, 0)[3], 0);
});

test("finalizeSvg restores source size and adds viewBox", () => {
  const svg = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="200" height="400">\n</svg>';
  const out = finalizeSvg(svg, 100, 200);
  assert.match(out, /width="100" height="200" viewBox="0 0 200 400"/);
});

test("finalizeSvg leaves unexpected roots unchanged", () => {
  const svg = "<svg><path/></svg>";
  assert.equal(finalizeSvg(svg, 10, 10), svg);
});

test("countPaths counts path elements", () => {
  assert.equal(countPaths('<svg><path d="M0 0"/><path d="M1 1"/></svg>'), 2);
  assert.equal(countPaths("<svg></svg>"), 0);
});

test("snapToImageColor finds nearest palette color within distance", () => {
  const img = makeImage(2, 1, [250, 250, 245, 255]); // off-white after quantize
  setPixel(img, 1, 0, [10, 10, 10, 255]);
  // User picked pure white; nearest image color is the off-white
  assert.deepEqual(snapToImageColor(img, [255, 255, 255], 48), [250, 250, 245]);
  // Nothing within 3 of pure red
  assert.equal(snapToImageColor(img, [255, 0, 0], 3), null);
});

test("snapToImageColor ignores transparent pixels", () => {
  const img = makeImage(2, 1, [255, 255, 255, 0]);
  setPixel(img, 1, 0, [40, 40, 40, 255]);
  assert.equal(snapToImageColor(img, [255, 255, 255], 16), null);
  assert.deepEqual(snapToImageColor(img, [50, 50, 50], 16), [40, 40, 40]);
});

test("assertRasterBudget passes typical sizes, rejects oversize", () => {
  assert.equal(assertRasterBudget(1000, 1000, 2), 4_000_000);
  assert.equal(assertRasterBudget(4000, 4000, 2), MAX_TRACE_PIXELS);
  assert.throws(() => assertRasterBudget(8000, 8000, 4), /too large to trace at 4x/);
  assert.throws(() => assertRasterBudget(8000, 8001, 1), /Lower the upscale/);
});

test("fitTraceScale keeps requested upscale for small images", () => {
  assert.equal(fitTraceScale(1000, 600, 2, 2048), 2); // 2000 <= 2048
  assert.equal(fitTraceScale(512, 512, 4, 2048), 4); // lands exactly on 2048
});

test("fitTraceScale caps mid-size images at the side limit", () => {
  // 1500 px source at 2x would be 3000: partial upscale to 2048.
  const scale = fitTraceScale(1500, 1000, 2, 2048);
  assert.equal(scale, 2048 / 1500);
  assert.equal(Math.round(1500 * scale), 2048);
});

test("fitTraceScale downscales large photos, proportions kept", () => {
  // 12.2 MP iPhone photo: longest side 4032 reduces to 2048.
  const scale = fitTraceScale(4032, 3024, 2, 2048);
  assert.ok(scale < 1, `expected sub-1 scale, got ${scale}`);
  assert.equal(Math.round(4032 * scale), 2048);
  // Portrait orientation uses the longest side too.
  assert.equal(fitTraceScale(3024, 4032, 2, 2048), 2048 / 4032);
  // The fitted scale must also pass the hard budget assert.
  assertRasterBudget(4032, 3024, scale);
});

test("fitTraceScale defaults to MAX_TRACE_SIDE", () => {
  assert.equal(fitTraceScale(4096, 4096, 1), MAX_TRACE_SIDE / 4096);
});

test("color-count presets resolve, cleanup scales inversely", () => {
  const two = resolveSettings("2", {});
  assert.deepEqual([two.colors, two.speckle, two.layerDiff], [2, 16, 48]);
  const six = resolveSettings("6", {});
  assert.deepEqual([six.colors, six.speckle, six.layerDiff], [6, 10, 26]);
  const many = resolveSettings("128", {});
  assert.deepEqual([many.colors, many.speckle, many.layerDiff], [128, 2, 8]);
});

test("resolveSettings: explicit beats preset beats defaults", () => {
  const s = resolveSettings("8", { colors: 5 });
  assert.equal(s.colors, 5); // explicit wins
  assert.equal(s.speckle, 8); // from preset
  assert.equal(s.layerDiff, 24); // from preset
  const d = resolveSettings(null, {});
  assert.equal(d.colors, 256);
  assert.equal(d.speckle, 8);
  assert.equal(d.layerDiff, 16);
});

test("defaults match initial and per-image reset settings", () => {
  assert.deepEqual(
    {
      edgeTrim: DEFAULTS.edgeTrim,
      defringe: DEFAULTS.defringe,
      fuzz: DEFAULTS.fuzz,
      crisp: DEFAULTS.crisp,
      denoise: DEFAULTS.denoise,
      grayscale: DEFAULTS.grayscale,
      mode: DEFAULTS.mode,
      speckle: DEFAULTS.speckle,
      layerDiff: DEFAULTS.layerDiff,
      cornerThreshold: DEFAULTS.cornerThreshold,
      hierarchical: DEFAULTS.hierarchical,
    },
    {
      edgeTrim: 0,
      defringe: 0,
      fuzz: 16,
      crisp: false,
      denoise: false,
      grayscale: false,
      mode: "spline",
      speckle: 8,
      layerDiff: 16,
      cornerThreshold: 60,
      hierarchical: "stacked",
    },
  );
});

test("erodeAlpha peels one boundary ring per pass", () => {
  // 5x5 opaque block inside a transparent 7x7 frame.
  const img = makeImage(7, 7, [0, 0, 0, 0]);
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) setPixel(img, x, y, [10, 10, 10, 255]);
  erodeAlpha(img, 1);
  assert.equal(getPixel(img, 1, 1)[3], 0); // ring peeled
  assert.equal(getPixel(img, 3, 1)[3], 0);
  assert.equal(getPixel(img, 2, 2)[3], 255); // interior survives
  assert.equal(getPixel(img, 3, 3)[3], 255);
  erodeAlpha(img, 1);
  assert.equal(getPixel(img, 2, 2)[3], 0); // next ring on second pass
  assert.equal(getPixel(img, 3, 3)[3], 255); // 1px core remains
});

test("erodeAlpha grows interior holes too", () => {
  const img = makeImage(5, 5, [10, 10, 10, 255]);
  setPixel(img, 2, 2, [0, 0, 0, 0]); // hole
  erodeAlpha(img, 1);
  assert.equal(getPixel(img, 2, 1)[3], 0); // hole neighbors peeled
  assert.equal(getPixel(img, 1, 2)[3], 0);
  assert.equal(getPixel(img, 1, 1)[3], 255); // diagonal not 4-adjacent, kept
  assert.equal(getPixel(img, 0, 0)[3], 255); // image border is not a boundary
});

test("erodeAlpha zero passes is a no-op and full erase terminates", () => {
  const img = makeImage(3, 3, [10, 10, 10, 255]);
  setPixel(img, 0, 0, [0, 0, 0, 0]);
  const before = [...img.data];
  erodeAlpha(img, 0);
  assert.deepEqual([...img.data], before);
  erodeAlpha(img, 50); // more passes than pixels: must stop cleanly
  assert.equal(getPixel(img, 2, 2)[3], 0);
});

test("defringeAlpha recolors the boundary ring from the interior", () => {
  // 5x5 opaque block in a transparent frame: interior dark, boundary
  // ring carrying light background-blend fringe.
  const img = makeImage(7, 7, [0, 0, 0, 0]);
  for (let y = 1; y < 6; y++) {
    for (let x = 1; x < 6; x++) setPixel(img, x, y, [200, 200, 200, 255]);
  }
  for (let y = 2; y < 5; y++) {
    for (let x = 2; x < 5; x++) setPixel(img, x, y, [10, 10, 10, 255]);
  }
  defringeAlpha(img, 1);
  assert.deepEqual(getPixel(img, 1, 1), [10, 10, 10, 255]); // fringe recolored
  assert.deepEqual(getPixel(img, 3, 1), [10, 10, 10, 255]);
  assert.deepEqual(getPixel(img, 3, 3), [10, 10, 10, 255]); // interior unchanged
  assert.equal(getPixel(img, 0, 0)[3], 0); // transparency untouched
});

test("defringeAlpha keeps thin features instead of erasing them", () => {
  // 1px line: erodeAlpha would delete it; defringe must leave it opaque
  // with its original color (no interior to pull from).
  const img = makeImage(5, 3, [0, 0, 0, 0]);
  for (let x = 0; x < 5; x++) setPixel(img, x, 1, [90, 30, 30, 255]);
  defringeAlpha(img, 2);
  for (let x = 0; x < 5; x++) assert.deepEqual(getPixel(img, x, 1), [90, 30, 30, 255]);
});

test("defringeAlpha zero depth is a no-op", () => {
  const img = makeImage(3, 3, [10, 10, 10, 255]);
  setPixel(img, 0, 0, [0, 0, 0, 0]);
  const before = [...img.data];
  defringeAlpha(img, 0);
  assert.deepEqual([...img.data], before);
});

test("removeBackground honors fuzz after palette snap (halo regression)", () => {
  // Quantized-style image: white bg cluster, near-white halo shade from
  // an anti-aliased boundary, dark subject. Snap resolves to the white
  // cluster; fuzz must still remove the halo shade or it survives as an
  // outline around the subject.
  const img = makeImage(3, 1, [255, 255, 255, 255]);
  setPixel(img, 1, 0, [240, 240, 240, 255]); // halo shade
  setPixel(img, 2, 0, [30, 30, 30, 255]); // subject
  const removed = removeBackground(img, [250, 250, 250], 16, true);
  assert.deepEqual(removed, [255, 255, 255]); // snapped to palette white
  assert.equal(getPixel(img, 0, 0)[3], 0); // background removed
  assert.equal(getPixel(img, 1, 0)[3], 0); // halo within fuzz removed
  assert.equal(getPixel(img, 2, 0)[3], 255); // subject kept
});

test("removeBackground with fuzz 0 removes only the exact cluster", () => {
  const img = makeImage(2, 1, [255, 255, 255, 255]);
  setPixel(img, 1, 0, [240, 240, 240, 255]);
  removeBackground(img, [255, 255, 255], 0, true);
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 1, 0)[3], 255);
});

test("removeBackground auto mode detects the corner color", () => {
  const img = makeImage(4, 4, [10, 20, 30, 255]);
  setPixel(img, 2, 2, [200, 0, 0, 255]);
  const removed = removeBackground(img, "auto", 0, false);
  assert.deepEqual(removed, [10, 20, 30]);
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 2, 2)[3], 255);
});

test("removeBackground edges mode flood fills from the border", () => {
  const img = makeImage(5, 5, [255, 255, 255, 255]);
  setPixel(img, 2, 2, [0, 0, 0, 255]);
  const removed = removeBackground(img, "edges", 16, false);
  assert.deepEqual(removed, [255, 255, 255]);
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 2, 2)[3], 255);
});

test("removeBackground returns null when off or nothing to remove", () => {
  const img = makeImage(2, 2, [255, 255, 255, 255]);
  assert.equal(removeBackground(img, null, 16, false), null);
  const clear = makeImage(2, 2, [0, 0, 0, 0]);
  assert.equal(removeBackground(clear, "auto", 16, false), null);
});

test("knockOutEdges removes border-connected background only", async () => {
  const { knockOutEdges } = await import("../js/preprocess.js");
  // White bg, black square, and a white HOLE inside the square that must stay
  const img = makeImage(10, 10, [255, 255, 255, 255]);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) setPixel(img, x, y, [0, 0, 0, 255]);
  setPixel(img, 5, 5, [255, 255, 255, 255]); // enclosed white pixel
  const seed = knockOutEdges(img, 16);
  assert.deepEqual(seed, [255, 255, 255]);
  assert.equal(getPixel(img, 0, 0)[3], 0); // border removed
  assert.equal(getPixel(img, 5, 5)[3], 255); // enclosed same-color pixel kept
  assert.equal(getPixel(img, 3, 3)[3], 255); // subject kept
});

test("knockOutEdges returns null when corners already transparent", async () => {
  const { knockOutEdges } = await import("../js/preprocess.js");
  const img = makeImage(4, 4, [255, 255, 255, 0]);
  assert.equal(knockOutEdges(img, 16), null);
});

test("analyzeFlatness flags flat image with anti-aliased fringe", () => {
  // 100x100: top half red, bottom half blue, plus a fringe row of 100
  // unique blend colors (1% of pixels) like anti-aliased edges produce.
  const img = makeImage(100, 100, [255, 0, 0, 255]);
  for (let y = 50; y < 100; y++) {
    for (let x = 0; x < 100; x++) setPixel(img, x, y, [0, 0, 255, 255]);
  }
  for (let x = 0; x < 100; x++) setPixel(img, x, 50, [155 - x, 0, 100 + x, 255]);
  const result = analyzeFlatness(img);
  assert.equal(result.flat, true);
  assert.equal(result.colorCount, 2);
});

test("analyzeFlatness rejects gradients", () => {
  // 256x100 horizontal gradient: 256 colors, ~0.4% coverage each.
  const img = makeImage(256, 100);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 256; x++) setPixel(img, x, y, [x, 128, 128, 255]);
  }
  assert.equal(analyzeFlatness(img).flat, false);
});

test("analyzeFlatness rejects fully transparent images", () => {
  const img = makeImage(10, 10, [50, 50, 50, 0]);
  assert.equal(analyzeFlatness(img).flat, false);
});

test("analyzeFlatness clamps colorCount to at least 2", () => {
  const img = makeImage(10, 10, [10, 20, 30, 255]);
  const result = analyzeFlatness(img);
  assert.equal(result.flat, true);
  assert.equal(result.colorCount, 2);
});

test("analyzeFlatness detects exact low-color images", () => {
  const img = makeImage(40, 20);
  const colors = Array.from({ length: 20 }, (_, i) => [
    (i * 47) % 256,
    (i * 83) % 256,
    (i * 131) % 256,
    255,
  ]);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) setPixel(img, x, y, colors[Math.floor(x / 2)]);
  }
  const result = analyzeFlatness(img);
  assert.equal(result.flat, true);
  assert.equal(result.colorCount, 20);
});

test("analyzeFlatness detects dominant clusters in noisy flat art", () => {
  const img = makeImage(100, 100);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) {
      const noise = (x * 17 + y * 31) % 41 - 20;
      const base =
        y < 45
          ? [8, 8, 8]
          : y < 85
            ? [236, 232, 220]
            : [145, 145, 135];
      setPixel(img, x, y, [
        Math.max(0, Math.min(255, base[0] + noise)),
        Math.max(0, Math.min(255, base[1] + noise)),
        Math.max(0, Math.min(255, base[2] + noise)),
        255,
      ]);
    }
  }
  const result = analyzeFlatness(img);
  assert.equal(result.flat, true);
  assert.equal(result.colorCount, 8);
});

test("analyzeFlatness counts colors needed for 95% coverage", () => {
  // Five equal-ish bands (one loses a row to fringe): 95% coverage needs
  // all five dominant colors, so colorCount must be exactly 5.
  const img = makeImage(100, 100);
  const bands = [
    [200, 40, 40, 255],
    [40, 200, 40, 255],
    [40, 40, 200, 255],
    [220, 220, 40, 255],
    [40, 220, 220, 255],
  ];
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) setPixel(img, x, y, bands[Math.floor(y / 20)]);
  }
  // One row of 100 unique anti-alias-style blends (1% of pixels).
  for (let x = 0; x < 100; x++) setPixel(img, x, 19, [100 + x, 50, 150 - x, 255]);
  const result = analyzeFlatness(img);
  assert.equal(result.flat, true);
  assert.equal(result.colorCount, 5);
});
