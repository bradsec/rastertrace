import { test } from "node:test";
import assert from "node:assert/strict";
import {
  oklabToSrgb,
  parseAse,
  parseHexColor,
  parseSwatchText,
  sampleRasterColor,
  srgbToOklab,
  SWATCHES_MAX,
  toHexColor,
} from "../js/color.js";
import {
  binarizeAlpha,
  defringeAlpha,
  despeckleColors,
  erodeAlpha,
  fillTransparent,
  medianFilter,
  modeFilter,
  removeSpecks,
  thresholdImage,
  toGrayscale,
  toGrayscaleColor,
} from "../js/filters.js";
import {
  analyzeFlatness,
  detectBackgroundColor,
  dominantOpaqueColor,
  knockOutColor,
  mapToPalette,
  quantize,
  reclaimFringe,
  reduceAndRemoveBackground,
  removeBackground,
  snapToImageColor,
} from "../js/preprocess.js";
import {
  DEFAULTS,
  detectedColorSettings,
  distinctColorCount,
  ENCLOSED_NO_LIMIT,
  EXPORT_PROFILES,
  mergePresets,
  physicalWidthValue,
  PRESETS,
  PRESETS_MAX,
  profileColorSettings,
  resolveSettings,
  sanitizePresets,
  sanitizeSettings,
  SIMPLIFY_LEVELS,
  simplifyLevel,
} from "../js/settings-schema.js";
import {
  applyExportOptions,
  applyStencilInk,
  compressSvgPaths,
  countPaths,
  finalizeSvg,
  groupSvgFills,
  isStaleModuleError,
  nameColorGroups,
  straightenPaths,
} from "../js/svg-output.js";
import {
  assertRasterBudget,
  fitTraceScale,
  MAX_TRACE_PIXELS,
  MAX_TRACE_SIDE,
  tracePixels,
} from "../js/raster.js";

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

test("sampleRasterColor maps preview coordinates to processed pixels", () => {
  const image = makeImage(2, 2, [0, 0, 0, 255]);
  setPixel(image, 0, 0, [12, 34, 56, 255]);
  setPixel(image, 1, 0, [78, 90, 123, 255]);
  setPixel(image, 0, 1, [145, 167, 189, 255]);
  setPixel(image, 1, 1, [210, 220, 230, 255]);

  assert.deepEqual(sampleRasterColor(image, 0.1, 0.1), [12, 34, 56]);
  assert.deepEqual(sampleRasterColor(image, 0.9, 0.1), [78, 90, 123]);
  assert.deepEqual(sampleRasterColor(image, 0.1, 0.9), [145, 167, 189]);
  assert.deepEqual(sampleRasterColor(image, 1, 1), [210, 220, 230]);
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

test("toGrayscaleColor matches the image grayscale conversion", () => {
  const img = makeImage(1, 1, [40, 120, 200, 255]);
  toGrayscale(img);
  assert.deepEqual(toGrayscaleColor([40, 120, 200]), getPixel(img, 0, 0).slice(0, 3));
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

test("quantize gives transparent pixels no palette weight", () => {
  // Proportions from a knocked-out flat image: a large transparent area,
  // a dark frame with dark ringing and blend shades, and a small cream
  // detail. Counting the transparent area as the dominant dark color
  // spent both slots on dark shades and painted the cream dark.
  const runs = [
    [[243, 234, 216, 0], 2186],
    [[60, 40, 30, 255], 130],
    [[56, 35, 26, 255], 19],
    [[47, 26, 17, 255], 19],
    [[206, 195, 178, 255], 19],
    [[97, 79, 68, 255], 19],
    [[243, 234, 216, 255], 5],
  ];
  const img = makeImage(
    runs.reduce((n, [, count]) => n + count, 0),
    1,
  );
  let x = 0;
  for (const [rgba, count] of runs) for (let k = 0; k < count; k++) setPixel(img, x++, 0, rgba);
  quantize(img, 2);
  const [r, g, b] = getPixel(img, x - 1, 0);
  assert.ok(r > 200 && g > 190 && b > 170, `cream detail kept, got ${[r, g, b]}`);
  assert.equal(getPixel(img, 0, 0)[3], 0); // alpha untouched
});

test("quantize merges the closest pair when the palette is one slot short", () => {
  // PP-001: dark greens and dark blues sit on negative Oklab a/b axes. The
  // old RGB sentinels (min=255, max=0) reported such an axis as |min|, so
  // median cut split the wrong box: the two greens 8 apart got merged while
  // the two blues 1 apart were kept, the opposite of the intended choice.
  // Repeats are deliberate: median cut splits at the pixel-weighted median,
  // so the counts are part of the case, not padding.
  const source = [
    [0, 0, 0],
    [0, 64, 0],
    [0, 56, 0],
    [0, 0, 0],
    [0, 0, 57],
    [0, 64, 0],
    [0, 0, 0],
    [0, 0, 56],
  ];
  const img = makeImage(source.length, 1);
  source.forEach((rgb, x) => setPixel(img, x, 0, [...rgb, 255]));
  quantize(img, 4);
  const at = (x) => getPixel(img, x, 0).slice(0, 3);
  assert.deepEqual(at(1), [0, 64, 0], "the brighter green survives untouched");
  assert.deepEqual(at(2), [0, 56, 0], "the darker green stays distinct from it");
  assert.deepEqual(at(4), at(7), "the two near-identical blues collapse together");
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

// PP-002/PP-003: the 3x3 filters run on fixed buffers rather than per-pixel
// arrays and Maps. Reference implementations pin the exact output so a
// future rewrite cannot silently drift.
function referenceMedian(img, passes) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let pass = 0; pass < passes; pass++) {
    out.set(data);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < 128) continue;
        const win = [[], [], []];
        for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
          for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
            const j = (ny * width + nx) * 4;
            if (data[j + 3] < 128) continue;
            for (let c = 0; c < 3; c++) win[c].push(data[j + c]);
          }
        }
        for (let c = 0; c < 3; c++) {
          win[c].sort((a, b) => a - b);
          out[i + c] = win[c][win[c].length >> 1];
        }
      }
    }
    data.set(out);
  }
  return img;
}

function referenceMode(img) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const counts = new Map();
      let best = -1;
      let bestCount = 0;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const j = (ny * width + nx) * 4;
          if (data[j + 3] < 128) continue;
          const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
          const n = (counts.get(key) || 0) + 1;
          counts.set(key, n);
          if (n > bestCount) {
            bestCount = n;
            best = key;
          }
        }
      }
      if (best >= 0 && bestCount >= 5) {
        out[i] = (best >> 16) & 0xff;
        out[i + 1] = (best >> 8) & 0xff;
        out[i + 2] = best & 0xff;
      }
    }
  }
  data.set(out);
  return img;
}

// Deterministic pseudo-random source: reproducible failures, no test flake.
function noisyImage(width, height, seed) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  for (let i = 0; i < data.length; i += 4) {
    data[i] = next() % 256;
    data[i + 1] = next() % 256;
    data[i + 2] = next() % 256;
    data[i + 3] = next() % 4 === 0 ? 0 : 255;
  }
  return { data, width, height };
}

test("medianFilter matches the reference window sort on noisy images", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const width = 1 + (seed % 7);
    const height = 1 + ((seed * 3) % 6);
    const source = noisyImage(width, height, seed);
    const fast = { ...source, data: new Uint8ClampedArray(source.data) };
    const reference = { ...source, data: new Uint8ClampedArray(source.data) };
    medianFilter(fast, 2);
    referenceMedian(reference, 2);
    assert.deepEqual([...fast.data], [...reference.data], `seed ${seed} (${width}x${height})`);
  }
});

test("modeFilter matches the reference Map tally on noisy images", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const width = 1 + (seed % 7);
    const height = 1 + ((seed * 3) % 6);
    const source = noisyImage(width, height, seed);
    // Collapse onto a small palette so 3x3 majorities actually occur.
    for (let i = 0; i < source.data.length; i += 4) {
      source.data[i] &= 0xc0;
      source.data[i + 1] &= 0xc0;
      source.data[i + 2] &= 0xc0;
    }
    const fast = { ...source, data: new Uint8ClampedArray(source.data) };
    const reference = { ...source, data: new Uint8ClampedArray(source.data) };
    modeFilter(fast);
    referenceMode(reference);
    assert.deepEqual([...fast.data], [...reference.data], `seed ${seed} (${width}x${height})`);
  }
});

test("finalizeSvg restores source size and adds viewBox", () => {
  const svg =
    '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="200" height="400">\n</svg>';
  const out = finalizeSvg(svg, 100, 200);
  assert.match(out, /width="100" height="200" viewBox="0 0 200 400" preserveAspectRatio="none"/);
});

test("finalizeSvg fills the source viewport when trace rounding changes its ratio", () => {
  const svg = '<svg width="1558" height="2048"><path d="M0 0H1558V2048H0Z"/></svg>';
  const out = finalizeSvg(svg, 2240, 2944);
  assert.match(
    out,
    /width="2240" height="2944" viewBox="0 0 1558 2048" preserveAspectRatio="none"/,
  );
});

test("finalizeSvg leaves unexpected roots unchanged", () => {
  const svg = "<svg><path/></svg>";
  assert.equal(finalizeSvg(svg, 10, 10), svg);
});

test("groupSvgFills wraps adjacent same-fill paths and strips per-path fill", () => {
  const svg = [
    '<svg width="4" height="4">',
    '<path d="M0 0" fill="#FF0000" transform="translate(0,0)"/>',
    '<path d="M1 1" fill="#FF0000" transform="translate(1,1)"/>',
    '<path d="M2 2" fill="#00FF00" transform="translate(2,2)"/>',
    "</svg>",
  ].join("\n");
  const out = groupSvgFills(svg);
  assert.match(
    out,
    /<g fill="#FF0000">\n<path d="M0 0" transform="translate\(0,0\)"\/>\n<path d="M1 1" transform="translate\(1,1\)"\/>\n<\/g>/,
  );
  // Lone green path stays ungrouped with its own fill.
  assert.match(out, /<path d="M2 2" fill="#00FF00" transform="translate\(2,2\)"\/>/);
  assert.equal(countPaths(out), 3);
});

test("groupSvgFills keeps document order across groups", () => {
  const svg = [
    '<path d="M0 0" fill="#AAA111"/>',
    '<path d="M1 1" fill="#AAA111"/>',
    '<path d="M2 2" fill="#BBB222"/>',
    '<path d="M3 3" fill="#AAA111"/>',
  ].join("\n");
  const out = groupSvgFills(svg);
  // Non-adjacent same-fill paths must NOT merge: stacking relies on order.
  const order = [...out.matchAll(/d="(M\d \d)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["M0 0", "M1 1", "M2 2", "M3 3"]);
  const idxGroup = out.indexOf('<g fill="#AAA111">');
  const idxB = out.indexOf('d="M2 2"');
  const idxLast = out.indexOf('d="M3 3"');
  assert.ok(idxGroup >= 0 && idxGroup < idxB && idxB < idxLast);
  // The trailing #AAA111 path keeps its own fill (run of one).
  assert.match(out, /<path d="M3 3" fill="#AAA111"\/>/);
});

test("groupSvgFills leaves single paths and pathless fills alone", () => {
  const single = '<svg>\n<path d="M0 0" fill="#123456"/>\n</svg>';
  assert.equal(groupSvgFills(single), single);
  const noFill = '<svg>\n<path d="M0 0"/>\n<path d="M1 1"/>\n</svg>';
  assert.equal(groupSvgFills(noFill), noFill);
});

test("nameColorGroups names groups by color and numbers repeats in stacked order", () => {
  const svg = [
    "<svg>",
    '<g fill="#FFFFFF">\n<path d="M0 0"/>\n<path d="M1 1"/>\n</g>',
    '<path d="M2 2" fill="#000000"/>',
    '<g fill="#FFFFFF">\n<path d="M3 3"/>\n<path d="M4 4"/>\n</g>',
    "</svg>",
  ].join("\n");
  const out = nameColorGroups(svg);
  const order = [...out.matchAll(/d="(M\d \d)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["M0 0", "M1 1", "M2 2", "M3 3", "M4 4"]);
  const ids = [...out.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["color-ffffff", "color-000000", "color-ffffff-2"]);
  assert.match(out, /<path id="color-000000" d="M2 2" fill="#000000"\/>/);
  assert.equal(countPaths(out), 5);
});

test("nameColorGroups merges adjacent runs that palette edits made identical", () => {
  const svg = [
    "<svg>",
    '<g fill="#111111">\n<path d="M0 0"/>\n<path d="M1 1"/>\n</g>',
    '<path d="M2 2" fill="#111111"/>',
    "</svg>",
  ].join("\n");
  const out = nameColorGroups(svg);
  assert.equal(out.match(/<g\b/g)?.length, 1);
  assert.match(out, /<g fill="#111111" id="color-111111">/);
  assert.equal(countPaths(out), 3);
});

test("nameColorGroups gathers each color into one group in mosaic output", () => {
  const svg = [
    '<svg><rect width="4" height="4" fill="#000000"/>',
    '<path d="M0 0" fill="#AA0000"/>',
    '<path d="M1 1" fill="#00BB00"/>',
    '<path d="M2 2" fill="#AA0000"/>',
    '<path d="M3 3" fill="#00BB00"/>',
    "</svg>",
  ].join("\n");
  const out = nameColorGroups(svg, { mosaic: true });
  const order = [...out.matchAll(/d="(M\d \d)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["M0 0", "M2 2", "M1 1", "M3 3"]);
  const ids = [...out.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["color-aa0000", "color-00bb00"]);
  // A rect is paint, not a color group.
  assert.match(out, /<rect width="4" height="4" fill="#000000"\/>/);
});

test("nameColorGroups leaves hidden and non-hex fills unnamed", () => {
  const svg = [
    "<svg>",
    '<g fill="none">\n<path d="M0 0"/>\n<path d="M1 1"/>\n</g>',
    '<path d="M2 2" fill="url(#p)"/>',
    "</svg>",
  ].join("\n");
  const out = nameColorGroups(svg);
  assert.doesNotMatch(out, /\sid=/);
  assert.equal(countPaths(out), 3);
});

test("finalizeSvg groups same-fill paths in vtracer output", () => {
  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="20" height="20">',
    '<path d="M0 0" fill="#010101" transform="translate(0,0)"/>',
    '<path d="M1 1" fill="#010101" transform="translate(1,1)"/>',
    "</svg>",
  ].join("\n");
  const out = finalizeSvg(svg, 10, 10);
  assert.match(out, /width="10" height="10" viewBox="0 0 20 20"/);
  assert.match(out, /<g fill="#010101">/);
  assert.equal(countPaths(out), 2);
});

test("applyStencilInk leaves black ink unchanged", () => {
  const svg =
    '<svg width="10" height="10" viewBox="0 0 10 10">\n<path d="M0 0" fill="#000000"/>\n</svg>';
  assert.equal(applyStencilInk(svg, "black"), svg);
});

test("applyStencilInk recolors to white with nothing behind it", () => {
  // One ink only: no backing rect, so the export is white on transparency.
  const svg =
    '<svg width="10" height="10" viewBox="0 0 40 40">\n<path d="M0 0" fill="#000000"/>\n</svg>';
  const out = applyStencilInk(svg, "white");
  assert.equal(
    out,
    '<svg width="10" height="10" viewBox="0 0 40 40">\n<path d="M0 0" fill="#ffffff"/>\n</svg>',
  );
});

test("applyStencilInk recolors grouped fills too", () => {
  const svg =
    '<svg width="10" height="10" viewBox="0 0 10 10">\n<g fill="#000000">\n<path d="M0 0"/>\n<path d="M1 1"/>\n</g>\n</svg>';
  const out = applyStencilInk(svg, "white");
  assert.match(out, /<g fill="#ffffff">/);
});

test("applyExportOptions rewrites physical size keeping viewBox", () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 400 200">\n<path d="M0 0"/>\n</svg>';
  const out = applyExportOptions(svg, { physicalWidth: 100, physicalUnit: "mm" });
  assert.match(out, /width="100mm" height="50mm" viewBox="0 0 400 200"/);
});

test("applyExportOptions rounds physical height to 2 decimals", () => {
  const svg = '<svg width="300" height="200" viewBox="0 0 300 200">\n</svg>';
  const out = applyExportOptions(svg, { physicalWidth: 10, physicalUnit: "in" });
  assert.match(out, /width="10in" height="6\.67in"/);
});

test("applyExportOptions rewrites custom pixel size keeping viewBox", () => {
  const svg = '<svg width="300" height="200" viewBox="0 0 300 200">\n</svg>';
  const out = applyExportOptions(svg, { physicalWidth: 450, physicalUnit: "px" });
  assert.match(out, /width="450px" height="300px" viewBox="0 0 300 200"/);
});

test("applyExportOptions adds role and title as first child, escaped", () => {
  const svg = '<svg width="10" height="10" viewBox="0 0 10 10">\n<path d="M0 0"/>\n</svg>';
  const out = applyExportOptions(svg, { title: "a <b> & c" });
  assert.match(out, /<svg[^>]* role="img">\n<title>a &lt;b&gt; &amp; c<\/title>\n<path/);
});

test("applyExportOptions strips XML-forbidden title characters", () => {
  const svg = '<svg width="10" height="10" viewBox="0 0 10 10"></svg>';
  const out = applyExportOptions(svg, { title: "scan\u0000\u000B😀" });
  assert.match(out, /<title>scan😀<\/title>/);
  assert.equal(out.includes("\u0000"), false);
  assert.equal(out.includes("\u000B"), false);
});

test("applyExportOptions minify strips xml declaration and comments", () => {
  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: visioncortex VTracer 0.6.5 -->\n<svg width="10" height="10" viewBox="0 0 10 10">\n</svg>';
  const out = applyExportOptions(svg, { minify: true });
  assert.equal(out, '<svg width="10" height="10" viewBox="0 0 10 10">\n</svg>');
});

test("applyExportOptions with no options returns input unchanged", () => {
  const svg = '<svg width="10" height="10" viewBox="0 0 10 10">\n</svg>';
  assert.equal(applyExportOptions(svg, {}), svg);
});

test("fillTransparent paints transparent pixels opaque with the color", () => {
  const img = makeImage(2, 1, [10, 20, 30, 0]);
  setPixel(img, 1, 0, [40, 40, 40, 255]);
  fillTransparent(img, [255, 255, 255]);
  assert.deepEqual(getPixel(img, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(getPixel(img, 1, 0), [40, 40, 40, 255]);
});

test("EXPORT_PROFILES cover expected keys with sane values", () => {
  for (const name of [
    "web",
    "balanced",
    "detail",
    "maxDetail",
    "pixelExact",
    "print",
    "monoBlack",
    "monoWhite",
    "laser",
    "vinyl",
    "lineArt",
    "icon",
  ]) {
    const p = EXPORT_PROFILES[name];
    assert.ok(p, `${name} profile exists`);
    assert.ok(p.pathPrecision >= 1 && p.pathPrecision <= 4);
    assert.ok(p.colors >= 2 && p.colors <= 256);
  }
  assert.equal(EXPORT_PROFILES.laser.stencil, true);
  assert.equal(EXPORT_PROFILES.web.minify, true);
  assert.equal(EXPORT_PROFILES.monoBlack.stencilInk, "black");
  assert.equal(EXPORT_PROFILES.monoWhite.stencilInk, "white");
  // Vinyl colors are separate pieces; print keeps stacked layers (no gaps).
  assert.equal(EXPORT_PROFILES.vinyl.hierarchical, "cutout");
  assert.equal(EXPORT_PROFILES.print.hierarchical, "stacked");
  assert.equal(EXPORT_PROFILES.lineArt.stencil, true);
  assert.equal(EXPORT_PROFILES.lineArt.denoise, true);
  assert.equal(EXPORT_PROFILES.icon.minify, true);
});

test("SIMPLIFY_LEVELS run from detailed to simple within the slider ranges", () => {
  for (const [i, level] of SIMPLIFY_LEVELS.entries()) {
    assert.ok(level.lengthThreshold >= 3.5 && level.lengthThreshold <= 10);
    assert.ok(level.spliceThreshold >= 10 && level.spliceThreshold <= 90);
    if (i === 0) continue;
    const prev = SIMPLIFY_LEVELS[i - 1];
    assert.ok(level.lengthThreshold >= prev.lengthThreshold);
    assert.ok(level.spliceThreshold > prev.spliceThreshold);
  }
});

test("simplifyLevel names the level for a pair, or -1 for a custom pair", () => {
  assert.equal(
    SIMPLIFY_LEVELS[simplifyLevel(DEFAULTS.lengthThreshold, DEFAULTS.spliceThreshold)]
      .spliceThreshold,
    DEFAULTS.spliceThreshold,
  );
  // Every export profile lands on a named level, never Custom.
  for (const [name, p] of Object.entries(EXPORT_PROFILES)) {
    const level = simplifyLevel(
      p.lengthThreshold ?? DEFAULTS.lengthThreshold,
      p.spliceThreshold ?? DEFAULTS.spliceThreshold,
    );
    assert.notEqual(level, -1, `${name} profile`);
  }
  assert.equal(simplifyLevel(9.5, 15), -1);
});

// mode "none" skips all curve/corner simplification, so a high color count
// is the only thing standing between a photographic source and a runaway
// trace: colors:64 measured at 134,243 paths / 34.5 MB / 52s on a 1.92 MP
// noisy source, versus 2,972 paths / 6.6 MB / 9.8s at colors:8. Guard the
// profile default against silently regressing back to an unsafe value.
test("pixelExact keeps lone pixels: no speckle filter, no upscale", () => {
  assert.equal(EXPORT_PROFILES.pixelExact.speckle, 0);
  assert.equal(EXPORT_PROFILES.pixelExact.upscale, 1);
});

test("pixelExact keeps colors low to bound mode:none path explosion", () => {
  assert.equal(EXPORT_PROFILES.pixelExact.mode, "none");
  assert.ok(
    EXPORT_PROFILES.pixelExact.colors <= 16,
    `pixelExact.colors is ${EXPORT_PROFILES.pixelExact.colors}, expected <= 16 to bound path count on photographic sources`,
  );
});

test("sanitizeSettings keeps only known keys with valid values", () => {
  const out = sanitizeSettings({
    colors: 16,
    speckle: 8,
    upscale: "auto",
    mode: "polygon",
    stencil: true,
    minify: false,
    physicalUnit: "mm",
    physicalWidth: 120.5,
    knockoutColor: "#aabbcc",
    bogusKey: "x",
    __proto__: { evil: 1 },
  });
  assert.deepEqual(out, {
    colors: 16,
    speckle: 8,
    upscale: "auto",
    mode: "polygon",
    stencil: true,
    minify: false,
    physicalUnit: "mm",
    physicalWidth: 120.5,
    knockoutColor: "#aabbcc",
  });
});

test("sanitizeSettings drops out-of-range and wrong-type values", () => {
  const out = sanitizeSettings({
    colors: 9999,
    speckle: -1,
    upscale: "huge",
    mode: 42,
    hierarchical: "sideways",
    stencil: "yes",
    physicalWidth: -5,
    knockoutColor: "javascript:alert(1)",
    pathPrecision: 7,
    transparent: "weird",
  });
  assert.deepEqual(out, {});
});

test("physicalWidthValue accepts finite bounded widths only", () => {
  assert.equal(physicalWidthValue("210"), 210);
  assert.equal(physicalWidthValue("1e309"), null);
  assert.equal(physicalWidthValue(100001), null);
  assert.equal(physicalWidthValue(0), null);
});

test("sanitizeSettings handles junk input", () => {
  assert.deepEqual(sanitizeSettings(null), {});
  assert.deepEqual(sanitizeSettings("nope"), {});
  assert.deepEqual(sanitizeSettings([1, 2]), {});
});

test("thresholdImage cuts to pure black/white at the threshold", () => {
  const img = makeImage(3, 1, [200, 200, 200, 255]);
  setPixel(img, 1, 0, [100, 100, 100, 255]);
  setPixel(img, 2, 0, [128, 128, 128, 255]);
  thresholdImage(img, 128);
  assert.deepEqual(getPixel(img, 0, 0), [255, 255, 255, 255]); // above
  assert.deepEqual(getPixel(img, 1, 0), [0, 0, 0, 255]); // below
  assert.deepEqual(getPixel(img, 2, 0), [255, 255, 255, 255]); // at threshold stays white
});

test("thresholdImage keeps alpha untouched", () => {
  const img = makeImage(1, 1, [40, 40, 40, 0]);
  thresholdImage(img, 128);
  assert.deepEqual(getPixel(img, 0, 0), [0, 0, 0, 0]);
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

test("defringeAlpha with keepPalette repaints only with colors already present", () => {
  // Interior split into two colors: averaging them would invent a third.
  const img = makeImage(8, 6, [0, 0, 0, 0]);
  for (let y = 1; y < 5; y++) {
    for (let x = 1; x < 7; x++) setPixel(img, x, y, [240, 240, 240, 255]);
  }
  for (let y = 2; y < 4; y++) {
    setPixel(img, 2, y, [200, 20, 20, 255]);
    setPixel(img, 3, y, [200, 20, 20, 255]);
    setPixel(img, 4, y, [20, 20, 200, 255]);
    setPixel(img, 5, y, [20, 20, 200, 255]);
  }
  defringeAlpha(img, 1, { keepPalette: true });
  const colors = new Set();
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      const [r, g, b, a] = getPixel(img, x, y);
      if (a) colors.add(`${r},${g},${b}`);
    }
  }
  assert.deepEqual([...colors].sort(), ["20,20,200", "200,20,20"]);
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

test("knockOutEdges handles a broad background with bounded storage", async () => {
  const { knockOutEdges } = await import("../js/preprocess.js");
  const width = 512;
  const height = 512;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 240;
    data[i + 1] = 240;
    data[i + 2] = 240;
    data[i + 3] = 255;
  }
  assert.deepEqual(knockOutEdges({ data, width, height }, 0), [240, 240, 240]);
  for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 0);
});

/** White canvas with a black square ring (outer 2..17, wall 2 px). */
function ringImage() {
  const img = makeImage(20, 20, [255, 255, 255, 255]);
  for (let y = 2; y < 18; y++) {
    for (let x = 2; x < 18; x++) {
      if (x < 4 || x >= 16 || y < 4 || y >= 16) setPixel(img, x, y, [0, 0, 0, 255]);
    }
  }
  return img;
}

test("removeBackground contiguous pick keeps same color inside the subject", () => {
  const img = ringImage();
  const removed = removeBackground(img, [255, 255, 255], 16, false, { contiguous: true });
  assert.deepEqual(removed, [255, 255, 255]);
  assert.equal(getPixel(img, 0, 0)[3], 0); // border-connected background removed
  assert.equal(getPixel(img, 10, 10)[3], 255); // enclosed white kept
  assert.equal(getPixel(img, 2, 2)[3], 255); // subject kept
});

test("removeBackground contiguous pick snaps to the palette when quantized", () => {
  const img = ringImage();
  const removed = removeBackground(img, [250, 250, 250], 0, true, { contiguous: true });
  assert.deepEqual(removed, [255, 255, 255]);
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 10, 10)[3], 255);
});

test("knockOutEdges also removes enclosed background at or above the minimum area", async () => {
  const { knockOutEdges } = await import("../js/preprocess.js");
  const img = ringImage(); // enclosed hole is 12x12 = 144 px
  // Black 3x3 block inside the hole with a 1 px white center.
  for (let y = 8; y < 11; y++) for (let x = 8; x < 11; x++) setPixel(img, x, y, [0, 0, 0, 255]);
  setPixel(img, 9, 9, [255, 255, 255, 255]);
  knockOutEdges(img, 16, 100);
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 5, 5)[3], 0); // large enclosed hole removed
  assert.equal(getPixel(img, 9, 9)[3], 255); // small enclosed pixel kept
  assert.equal(getPixel(img, 3, 3)[3], 255); // subject kept
});

test("knockOutEdges keeps enclosed background below the minimum area", async () => {
  const { knockOutEdges } = await import("../js/preprocess.js");
  const img = ringImage();
  knockOutEdges(img, 16, 145);
  assert.equal(getPixel(img, 10, 10)[3], 255);
});

test("knockOutConnected keeps enclosed areas above the maximum area", async () => {
  const { knockOutConnected } = await import("../js/preprocess.js");
  const img = ringImage(); // enclosed hole is 12x12 = 144 px
  for (let y = 8; y < 11; y++) for (let x = 8; x < 11; x++) setPixel(img, x, y, [0, 0, 0, 255]);
  setPixel(img, 9, 9, [255, 255, 255, 255]); // 1 px enclosed region
  knockOutConnected(img, [255, 255, 255], 16, 1, { enclosedMaxArea: 100 });
  assert.equal(getPixel(img, 0, 0)[3], 0); // border-connected background still removed
  assert.equal(getPixel(img, 9, 9)[3], 0); // small enclosed region removed
  assert.equal(getPixel(img, 5, 5)[3], 255); // large enclosed region kept
});

test("reduceAndRemoveBackground keeps single pixels when no colors were reduced", () => {
  // Pixel art within the color budget: quantize leaves it untouched, so
  // there is no dither for the majority filter to clean, and lone pixels
  // are real detail.
  const img = makeImage(9, 9, [32, 48, 64, 255]);
  setPixel(img, 4, 4, [255, 64, 96, 255]);
  reduceAndRemoveBackground(img, 8, { transparent: "" });
  assert.deepEqual(getPixel(img, 4, 4).slice(0, 3), [255, 64, 96]);
});

test("reduceAndRemoveBackground still cleans dither after reducing colors", () => {
  const img = makeImage(9, 9, [32, 48, 64, 255]);
  setPixel(img, 4, 4, [255, 64, 96, 255]);
  setPixel(img, 0, 0, [250, 250, 250, 255]);
  setPixel(img, 8, 8, [0, 200, 0, 255]);
  reduceAndRemoveBackground(img, 2, { transparent: "" });
  assert.deepEqual(getPixel(img, 4, 4).slice(0, 3), [32, 48, 64]);
});

test("reduceAndRemoveBackground sizes the enclosed maximum in source pixels", () => {
  // Hole is 144 trace px. At scale 2, a 5 px maximum is 100 trace px:
  // kept. ENCLOSED_NO_LIMIT removes it.
  const bg = { transparent: "edges", fuzz: 16, enclosed: true, enclosedSize: 1, scale: 2 };
  const capped = ringImage();
  reduceAndRemoveBackground(capped, 256, { ...bg, enclosedMaxSize: 5 });
  assert.equal(getPixel(capped, 10, 10)[3], 255);
  const open = ringImage();
  reduceAndRemoveBackground(open, 256, { ...bg, enclosedMaxSize: ENCLOSED_NO_LIMIT });
  assert.equal(getPixel(open, 10, 10)[3], 0);
});

test("removeBackground enclosed option removes holes in edges and contiguous modes", () => {
  const edges = ringImage();
  removeBackground(edges, "edges", 16, false, { enclosedMinArea: 1 });
  assert.equal(getPixel(edges, 10, 10)[3], 0);
  assert.equal(getPixel(edges, 3, 3)[3], 255);
  const picked = ringImage();
  removeBackground(picked, [255, 255, 255], 16, false, { contiguous: true, enclosedMinArea: 1 });
  assert.equal(getPixel(picked, 10, 10)[3], 0);
});

test("reduceAndRemoveBackground sizes enclosed areas in source pixels", () => {
  // Hole is 12x12 = 144 trace px. At trace scale 2, 6 source px across
  // is 12 trace px (144 px): removed. 7 across is 196 px: kept.
  const bg = { transparent: "edges", fuzz: 16, enclosed: true, scale: 2 };
  const removed = ringImage();
  reduceAndRemoveBackground(removed, 256, { ...bg, enclosedSize: 6 });
  assert.equal(getPixel(removed, 10, 10)[3], 0);
  const kept = ringImage();
  reduceAndRemoveBackground(kept, 256, { ...bg, enclosedSize: 7 });
  assert.equal(getPixel(kept, 10, 10)[3], 255);
  const off = ringImage();
  reduceAndRemoveBackground(off, 256, { ...bg, enclosed: false, enclosedSize: 1 });
  assert.equal(getPixel(off, 10, 10)[3], 255);
});

/** Horizontal gray ramp from `from` to `to` (inclusive), opaque. */
function rampImage(width, height, from, to) {
  const img = makeImage(width, height, [0, 0, 0, 255]);
  for (let x = 0; x < width; x++) {
    const v = Math.round(from + ((to - from) * x) / (width - 1));
    for (let y = 0; y < height; y++) setPixel(img, x, y, [v, v, v, 255]);
  }
  return img;
}

test("knockOutConnected follows a gradient background when asked", async () => {
  const { knockOutConnected } = await import("../js/preprocess.js");
  const flat = rampImage(40, 10, 255, 185);
  knockOutConnected(flat, [255, 255, 255], 16);
  assert.equal(getPixel(flat, 0, 5)[3], 0);
  assert.equal(getPixel(flat, 39, 5)[3], 255); // beyond fuzz of the seed: kept

  const img = rampImage(40, 10, 255, 185);
  for (let y = 3; y < 7; y++) for (let x = 18; x < 22; x++) setPixel(img, x, y, [0, 0, 0, 255]);
  knockOutConnected(img, [255, 255, 255], 16, 0, { gradient: true });
  assert.equal(getPixel(img, 0, 5)[3], 0);
  assert.equal(getPixel(img, 39, 5)[3], 0); // whole ramp removed
  assert.equal(getPixel(img, 20, 5)[3], 255); // subject kept
});

test("knockOutConnected gradient flood stops at the drift cap", async () => {
  const { knockOutConnected } = await import("../js/preprocess.js");
  const img = rampImage(100, 4, 255, 60);
  knockOutConnected(img, [255, 255, 255], 16, 0, { gradient: true });
  assert.equal(getPixel(img, 0, 1)[3], 0);
  assert.equal(getPixel(img, 99, 1)[3], 255); // far from the seed: kept
});

test("removeBackground passes the gradient option to edges mode", () => {
  const img = rampImage(40, 10, 255, 185);
  removeBackground(img, "edges", 16, false, { gradient: true });
  assert.equal(getPixel(img, 39, 5)[3], 0);
});

test("reduceAndRemoveBackground masks edges before quantizing (no leak)", () => {
  // White bg, light gray subject touching it, dark subject. At 2 colors
  // the light gray would share the white palette slot and the edge flood
  // would run straight through it.
  const img = makeImage(30, 10, [255, 255, 255, 255]);
  for (let y = 2; y < 8; y++) {
    for (let x = 5; x < 15; x++) setPixel(img, x, y, [225, 225, 225, 255]);
    for (let x = 15; x < 25; x++) setPixel(img, x, y, [20, 20, 20, 255]);
  }
  const seed = reduceAndRemoveBackground(img, 2, { transparent: "edges", fuzz: 16 });
  assert.deepEqual(seed, [255, 255, 255]);
  assert.equal(getPixel(img, 0, 0)[3], 0); // background removed
  assert.equal(getPixel(img, 8, 5)[3], 255); // light subject kept
  assert.equal(getPixel(img, 20, 5)[3], 255); // dark subject kept
});

test("reduceAndRemoveBackground keeps global modes quantize-first", () => {
  // Off-white highlight collapses into the white palette slot and goes
  // with it: global removal semantics are unchanged.
  const img = makeImage(10, 10, [255, 255, 255, 255]);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) setPixel(img, x, y, [20, 20, 20, 255]);
  for (let y = 3; y < 6; y++) for (let x = 3; x < 6; x++) setPixel(img, x, y, [235, 235, 235, 255]);
  const removed = reduceAndRemoveBackground(img, 2, { transparent: "auto", fuzz: 0 });
  assert.ok(removed);
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 4, 4)[3], 0); // highlight went with the background slot
  assert.equal(getPixel(img, 6, 6)[3], 255); // dark subject kept
});

test("reduceAndRemoveBackground without background only quantizes", () => {
  const img = makeImage(4, 1, [255, 255, 255, 255]);
  setPixel(img, 1, 0, [250, 250, 250, 255]);
  setPixel(img, 2, 0, [0, 0, 0, 255]);
  assert.equal(reduceAndRemoveBackground(img, 2, { transparent: "", fuzz: 16 }), null);
  for (let x = 0; x < 4; x++) assert.equal(getPixel(img, x, 0)[3], 255);
  assert.ok(new Set([0, 1, 2, 3].map((x) => getPixel(img, x, 0).join())).size <= 2);
});

test("reclaimFringe clears edge pixels closer to the background than their palette color", () => {
  // Row: transparent bg | fringe | subject. Fringe was near-white before
  // quantizing and got snapped to the subject's palette color.
  const img = makeImage(6, 1, [40, 40, 40, 255]);
  setPixel(img, 0, 0, [255, 255, 255, 0]);
  const original = new Uint8ClampedArray(img.data);
  original.set([230, 230, 230, 255], 4); // x=1 fringe: near background
  original.set([60, 60, 60, 255], 8); // x=2: near its palette color
  reclaimFringe(img, original, [255, 255, 255], 2);
  assert.equal(getPixel(img, 1, 0)[3], 0); // fringe reclaimed
  assert.equal(getPixel(img, 2, 0)[3], 255); // subject kept
  assert.equal(getPixel(img, 4, 0)[3], 255);
});

test("reclaimFringe grows at most `rings` pixels", () => {
  const img = makeImage(6, 1, [40, 40, 40, 255]);
  setPixel(img, 0, 0, [255, 255, 255, 0]);
  const original = new Uint8ClampedArray(img.data);
  for (let x = 1; x < 6; x++) original.set([240, 240, 240, 255], x * 4);
  reclaimFringe(img, original, [255, 255, 255], 2);
  assert.equal(getPixel(img, 2, 0)[3], 0);
  assert.equal(getPixel(img, 3, 0)[3], 255);
});

test("removeSpecks drops small opaque islands and fills small enclosed pinholes", () => {
  const img = makeImage(20, 20, [0, 0, 0, 0]);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) setPixel(img, x, y, [200, 0, 0, 255]);
  setPixel(img, 9, 9, [0, 0, 0, 0]); // pinhole inside the subject
  setPixel(img, 1, 1, [0, 0, 255, 255]); // stray opaque speck
  removeSpecks(img, 2); // areas below 2 * 2 = 4 px
  assert.equal(getPixel(img, 1, 1)[3], 0); // speck removed
  assert.deepEqual(getPixel(img, 9, 9), [200, 0, 0, 255]); // pinhole filled with surrounding color
  assert.equal(getPixel(img, 7, 7)[3], 255); // subject kept
  assert.equal(getPixel(img, 0, 0)[3], 0); // background stays transparent
});

test("removeSpecks keeps regions at the size limit and border-touching gaps", () => {
  const img = makeImage(10, 10, [0, 0, 0, 0]);
  for (let y = 1; y < 3; y++) for (let x = 1; x < 3; x++) setPixel(img, x, y, [9, 9, 9, 255]);
  const before = [...img.data];
  removeSpecks(img, 2); // 2x2 island is exactly 4 px: kept
  assert.deepEqual([...img.data], before);
  const solid = makeImage(4, 4, [9, 9, 9, 255]);
  setPixel(solid, 0, 1, [0, 0, 0, 0]); // 1 px gap on the border: not a hole
  removeSpecks(solid, 2);
  assert.equal(getPixel(solid, 0, 1)[3], 0);
});

test("removeSpecks with size 0 is a no-op", () => {
  const img = makeImage(3, 3, [0, 0, 0, 0]);
  setPixel(img, 1, 1, [9, 9, 9, 255]);
  const before = [...img.data];
  removeSpecks(img, 0);
  assert.deepEqual([...img.data], before);
});

test("detectedColorSettings snaps flat images to the nearest preset at or above the count", () => {
  assert.deepEqual(detectedColorSettings({ flat: true, colorCount: 5 }), {
    colors: 5,
    speckle: PRESETS[6].speckle,
    layerDiff: PRESETS[6].layerDiff,
  });
  assert.deepEqual(detectedColorSettings({ flat: true, colorCount: 2 }), {
    colors: 2,
    speckle: PRESETS[2].speckle,
    layerDiff: PRESETS[2].layerDiff,
  });
});

test("detectedColorSettings returns defaults for photographic images", () => {
  // A photo after a flat image must not inherit the flat image's colors.
  assert.deepEqual(detectedColorSettings({ flat: false, colorCount: 4000 }), {
    colors: DEFAULTS.colors,
    speckle: DEFAULTS.speckle,
    layerDiff: DEFAULTS.layerDiff,
  });
});

test("sanitizeSettings keeps autoDetect booleans only", () => {
  assert.deepEqual(sanitizeSettings({ autoDetect: false }), { autoDetect: false });
  assert.deepEqual(sanitizeSettings({ autoDetect: "yes" }), {});
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
      const noise = ((x * 17 + y * 31) % 41) - 20;
      const base = y < 45 ? [8, 8, 8] : y < 85 ? [236, 232, 220] : [145, 145, 135];
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

test("analyzeFlatness counts small solid accents past 95% coverage", () => {
  // Four bands plus four 6x6 accent blocks (0.36% each): the accents sit
  // in the last 5% of coverage but are real colors of the artwork.
  const img = makeImage(100, 100);
  const bands = [
    [200, 40, 40, 255],
    [40, 200, 40, 255],
    [40, 40, 200, 255],
    [220, 220, 40, 255],
  ];
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) setPixel(img, x, y, bands[Math.floor(y / 25)]);
  }
  const accents = [
    [255, 0, 110, 255],
    [6, 214, 160, 255],
    [255, 190, 11, 255],
    [58, 134, 255, 255],
  ];
  accents.forEach((rgba, i) => {
    for (let y = 10; y < 16; y++) {
      for (let x = 10 + i * 20; x < 16 + i * 20; x++) setPixel(img, x, y, rgba);
    }
  });
  const result = analyzeFlatness(img);
  assert.equal(result.flat, true);
  assert.equal(result.colorCount, 8);
  assert.equal(result.solids.length, 8);
});

test("analyzeFlatness does not count a thin anti-alias blend as a color", () => {
  // A half-row of one blend color (0.5%) along a band edge has no
  // interior pixels: it is fringe, not a color of the artwork.
  const img = makeImage(100, 100, [200, 40, 40, 255]);
  for (let y = 50; y < 100; y++) {
    for (let x = 0; x < 100; x++) setPixel(img, x, y, [40, 40, 200, 255]);
  }
  for (let x = 0; x < 50; x++) setPixel(img, x, 50, [120, 40, 120, 255]);
  assert.equal(analyzeFlatness(img).colorCount, 2);
});

test("detectedColorSettings keeps Merge below the closest pair of colors", () => {
  const solids = [
    [0, 0, 0],
    [60, 0, 0],
    [255, 255, 255],
  ];
  // Closest pair differs by 60 (sum of channel differences): Merge 30.
  assert.equal(detectedColorSettings({ flat: true, colorCount: 3, solids }).layerDiff, 30);
  // Near-identical shades (8 apart) do not drag Merge below 12, and
  // shades within it share one color in the count.
  const dark = [
    [22, 6, 0],
    [4, 0, 0],
    [12, 0, 0],
    [245, 235, 217],
  ];
  const merged = detectedColorSettings({ flat: true, colorCount: 4, solids: dark });
  assert.equal(merged.layerDiff, 12);
  assert.equal(merged.colors, 3);
  // The floor holds even when the closest pair alone would set less.
  const many = [...Array(13)].map((_, i) => [i * 19, 255 - i * 19, 0]);
  many.push([0, 255, 20]);
  assert.equal(detectedColorSettings({ flat: true, colorCount: 14, solids: many }).layerDiff, 12);
  // Well separated colors keep the preset's Merge.
  const far = [
    [0, 0, 0],
    [255, 255, 255],
  ];
  assert.equal(
    detectedColorSettings({ flat: true, colorCount: 2, solids: far }).layerDiff,
    PRESETS[2].layerDiff,
  );
});

test("distinctColorCount drops colors within Merge of a more common one", () => {
  // Most common first, as analyzeFlatness lists solids.
  const solids = [
    [0, 0, 0],
    [20, 0, 0],
    [40, 0, 0],
    [255, 255, 255],
  ];
  assert.equal(distinctColorCount(solids, 10), 4);
  // 20 is within Merge of 0; 40 is not, so it keeps its own slot, as in
  // quantize's flat-art seeding.
  assert.equal(distinctColorCount(solids, 20), 3);
  // Never below the Max colors minimum of 2.
  assert.equal(distinctColorCount(solids, 1000), 2);
});

test("straightenPaths converts near-straight cubics to lines", () => {
  const svg =
    '<path d="M0 0 C10 0.05 20 -0.05 30 0 Z " fill="#000000" transform="translate(0,0)"/>';
  const out = straightenPaths(svg, 0.5);
  assert.match(out, /d="M0 0 L30 0 Z "/);
  // fill and transform stay untouched
  assert.match(out, /fill="#000000" transform="translate\(0,0\)"/);
});

test("straightenPaths keeps genuinely curved cubics", () => {
  const svg = '<path d="M0 0 C10 10 20 10 30 0 Z "/>';
  assert.equal(straightenPaths(svg, 0.5), svg);
});

test("straightenPaths merges collinear line runs", () => {
  const svg = '<path d="M0 0 L10 0.1 L20 -0.1 L30 0 L30 30 Z "/>';
  const out = straightenPaths(svg, 0.5);
  assert.match(out, /d="M0 0 L30 0 L30 30 Z "/);
});

test("straightenPaths merges lines produced from converted cubics", () => {
  const svg = '<path d="M0 0 C5 0.05 10 -0.05 15 0 L30 0.1 L45 0 L45 45 Z "/>';
  const out = straightenPaths(svg, 0.5);
  assert.match(out, /d="M0 0 L45 0 L45 45 Z "/);
});

test("straightenPaths does not merge across corners", () => {
  const svg = '<path d="M0 0 L10 0 L10 10 L0 10 Z "/>';
  assert.equal(straightenPaths(svg, 0.5), svg);
});

test("straightenPaths handles compound subpaths independently", () => {
  const svg = '<path d="M0 0 L10 0.1 L20 0 L20 20 Z M5 5 L8 5.05 L11 5 L11 11 Z "/>';
  const out = straightenPaths(svg, 0.5);
  assert.match(out, /d="M0 0 L20 0 L20 20 Z M5 5 L11 5 L11 11 Z "/);
});

test("straightenPaths at tolerance 0 returns input unchanged", () => {
  const svg = '<path d="M0 0 C10 0.05 20 -0.05 30 0 Z "/>';
  assert.equal(straightenPaths(svg, 0), svg);
});

test("straightenPaths output still parses for DXF/PDF export", async () => {
  const { parseSvgPaths } = await import("../js/vectorexport.js");
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 200 200">',
    '<path d="M0 0 L100 0.2 L200 0 C200 50 200 150 200 200 L0 200 Z " fill="#123456" transform="translate(3,4)"/>',
    "</svg>",
  ].join("\n");
  const out = straightenPaths(svg, 0.5);
  const parsed = parseSvgPaths(out);
  assert.equal(parsed.paths.length, 1);
  const sub = parsed.paths[0].subpaths[0];
  assert.equal(sub.closed, true);
  // translate still applies and the wobbly top edge collapsed to one line
  assert.deepEqual(sub.start, { x: 3, y: 4 });
  assert.deepEqual(sub.segments[0], { kind: "line", to: { x: 203, y: 4 } });
});

test("straighten setting has a default, validates, and appears in profiles", () => {
  assert.equal(DEFAULTS.straighten, 1);
  assert.deepEqual(sanitizeSettings({ straighten: 1.5 }), { straighten: 1.5 });
  assert.deepEqual(sanitizeSettings({ straighten: -1 }), {});
  assert.deepEqual(sanitizeSettings({ straighten: 99 }), {});
  for (const [name, profile] of Object.entries(EXPORT_PROFILES)) {
    assert.ok(Number.isFinite(profile.straighten), `${name} missing straighten`);
  }
});

test("compressSvgPaths bakes translate into coordinates and drops the transform", () => {
  const svg = '<path d="M10 10 L20 10 Z " fill="#000000" transform="translate(5,5)"/>';
  const out = compressSvgPaths(svg);
  assert.match(out, /d="M15 15h10z"/);
  assert.doesNotMatch(out, /transform=/);
  assert.match(out, /fill="#000000"/);
});

test("compressSvgPaths converts to relative commands with h/v shorthands", () => {
  const svg = '<path d="M10 10 L20 10 L20 20 L10 20 Z "/>';
  assert.equal(compressSvgPaths(svg), '<path d="M10 10h10v10h-10z"/>');
});

test("compressSvgPaths uses implicit command repetition and tight separators", () => {
  const svg = '<path d="M0 0 L5 1 L10 3 L4 -2 Z "/>';
  assert.equal(compressSvgPaths(svg), '<path d="M0 0l5 1 5 2-6-5z"/>');
});

test("compressSvgPaths converts smooth curve pairs to s", () => {
  const svg = '<path d="M0 0 C10 0 20 10 30 10 C40 10 50 0 60 0 Z "/>';
  assert.equal(compressSvgPaths(svg), '<path d="M0 0c10 0 20 10 30 10s20-10 30-10z"/>');
});

test("compressSvgPaths keeps compound subpaths with relative m", () => {
  const svg = '<path d="M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z "/>';
  assert.equal(compressSvgPaths(svg), '<path d="M0 0h10v10zm20 20h10v10z"/>');
});

test("compressSvgPaths trims number noise", () => {
  const svg = '<path d="M0.50 -0.25 L10.50 -0.25 Z "/>';
  assert.equal(compressSvgPaths(svg), '<path d="M.5-.25h10z"/>');
});

test("compressSvgPaths leaves non-translate transforms and odd commands alone", () => {
  const svg = '<path d="M0 0 A5 5 0 0 1 10 10" transform="rotate(45)"/>';
  assert.equal(compressSvgPaths(svg), svg);
});

test("compressSvgPaths shrinks realistic traced output", () => {
  const svg =
    '<path d="M100 100 L200.25 100.5 L200.25 200.75 L100 200.75 Z M300 300 C310 300 320 310 320 320 L300 320 Z " fill="#123456" transform="translate(7,9)"/>';
  const out = compressSvgPaths(svg);
  assert.ok(out.length < svg.length * 0.75, `only got ${out.length}/${svg.length}`);
});

test("applyExportOptions minify also compresses path data", () => {
  const svg =
    '<?xml version="1.0"?>\n<svg width="10" height="10" viewBox="0 0 10 10">\n<path d="M0 0 L5 0 L5 5 Z " fill="#000000" transform="translate(1,1)"/>\n</svg>';
  const out = applyExportOptions(svg, { minify: true });
  assert.doesNotMatch(out, /<\?xml|transform=/);
  assert.match(out, /d="M1 1h5v5z"/);
});

test("isStaleModuleError matches module load failures only", () => {
  assert.equal(isStaleModuleError("Importing binding name 'straightenPaths' is not found."), true);
  assert.equal(
    isStaleModuleError(
      "The requested module './preprocess.js?v=40' does not provide an export named 'straightenPaths'",
    ),
    true,
  );
  assert.equal(isStaleModuleError("SyntaxError: Unexpected token '<'"), true);
  assert.equal(isStaleModuleError("Image is too large to trace at 4x"), false);
  assert.equal(isStaleModuleError("Conversion failed."), false);
  assert.equal(isStaleModuleError(""), false);
});

test("sanitizePresets keeps valid named presets and drops session-only keys", () => {
  const out = sanitizePresets({
    app: "rastertrace",
    presets: [
      {
        name: "  Client logo ",
        settings: { colors: 8, profile: "web", autoDetect: true, bogus: 1 },
      },
      { name: "client LOGO", settings: { colors: 4 } },
      { name: "", settings: { colors: 4 } },
      { name: "x".repeat(41), settings: {} },
      { name: "bad\u0000name", settings: { colors: 999, speckle: 4 } },
      null,
      "nope",
    ],
  });
  assert.deepEqual(out, [
    { name: "Client logo", settings: { colors: 8 } },
    { name: "badname", settings: { speckle: 4 } },
  ]);
  assert.deepEqual(sanitizePresets("not json"), []);
  assert.deepEqual(sanitizePresets([{ name: "Bare array", settings: { minify: true } }]), [
    { name: "Bare array", settings: { minify: true } },
  ]);
});

test("sanitizePresets caps the list", () => {
  const many = Array.from({ length: PRESETS_MAX + 5 }, (_, i) => ({ name: `P${i}`, settings: {} }));
  assert.equal(sanitizePresets(many).length, PRESETS_MAX);
});

test("mergePresets replaces same names in place, appends new ones, and respects the cap", () => {
  const list = [
    { name: "Logo", settings: { colors: 8 } },
    { name: "Laser", settings: { stencil: true } },
  ];
  const merged = mergePresets(list, [
    { name: "logo", settings: { colors: 4 } },
    { name: "Web", settings: { minify: true } },
  ]);
  assert.deepEqual(merged.presets, [
    { name: "logo", settings: { colors: 4 } },
    { name: "Laser", settings: { stencil: true } },
    { name: "Web", settings: { minify: true } },
  ]);
  assert.deepEqual(merged.replaced, ["logo"]);
  assert.deepEqual(merged.added, ["Web"]);
  assert.deepEqual(merged.skipped, []);
  // The input list is not mutated.
  assert.equal(list[0].settings.colors, 8);

  const kept = mergePresets(list, [{ name: "LOGO", settings: {} }], { replace: false });
  assert.deepEqual(kept.presets, list);
  assert.deepEqual(kept.skipped, ["LOGO"]);

  const full = Array.from({ length: PRESETS_MAX }, (_, i) => ({ name: `P${i}`, settings: {} }));
  const over = mergePresets(full, [{ name: "One more", settings: {} }]);
  assert.equal(over.presets.length, PRESETS_MAX);
  assert.deepEqual(over.skipped, ["One more"]);
});

test("sanitizeSettings accepts a saved user preset as the active profile", () => {
  assert.deepEqual(sanitizeSettings({ profile: "user:Client logo" }), {
    profile: "user:Client logo",
  });
  assert.deepEqual(sanitizeSettings({ profile: "user:" }), {});
  assert.deepEqual(sanitizeSettings({ profile: "nonsense" }), {});
});

/** Adobe Swatch Exchange bytes for [name, model, values, type] entries, in one group. */
function aseBytes(entries) {
  const blocks = [];
  const nameBytes = (name) => {
    const units = [...name].map((c) => c.charCodeAt(0)).concat(0);
    const out = new Uint8Array(2 + units.length * 2);
    const view = new DataView(out.buffer);
    view.setUint16(0, units.length);
    units.forEach((u, i) => view.setUint16(2 + i * 2, u));
    return out;
  };
  const block = (type, body) => {
    const out = new Uint8Array(6 + body.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, type);
    view.setUint32(2, body.length);
    out.set(body, 6);
    blocks.push(out);
  };
  block(0xc001, nameBytes("Brand"));
  for (const [name, model, values, type] of entries) {
    const head = nameBytes(name);
    const body = new Uint8Array(head.length + 4 + values.length * 4 + 2);
    const view = new DataView(body.buffer);
    body.set(head, 0);
    let o = head.length;
    for (const ch of model) body[o++] = ch.charCodeAt(0);
    for (const v of values) {
      view.setFloat32(o, v);
      o += 4;
    }
    view.setUint16(o, type);
    block(0x0001, body);
  }
  block(0xc002, new Uint8Array(0));
  const size = 12 + blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([0x41, 0x53, 0x45, 0x46], 0);
  view.setUint16(4, 1);
  view.setUint16(6, 0);
  view.setUint32(8, blocks.length);
  let o = 12;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

test("parseAse reads RGB swatches exactly and flags converted CMYK, Lab and spot colors", () => {
  const rgbOnly = parseAse(
    aseBytes([
      ["Red", "RGB ", [1, 0, 0], 2],
      ["Navy", "RGB ", [0, 0, 0.5], 0],
    ]),
  );
  assert.deepEqual(rgbOnly, { swatches: ["#FF0000", "#000080"], approximate: false });

  const mixed = parseAse(
    aseBytes([
      ["Cyan", "CMYK", [1, 0, 0, 0], 2],
      ["White", "LAB ", [1, 0, 0], 2],
      ["Spot", "RGB ", [0, 1, 0], 1],
      ["Red", "RGB ", [1, 0, 0], 2],
    ]),
  );
  assert.equal(mixed.approximate, true);
  assert.equal(mixed.swatches[0], "#00FFFF");
  assert.equal(mixed.swatches[1], "#FFFFFF");
  assert.deepEqual(mixed.swatches.slice(2), ["#00FF00", "#FF0000"]);
});

test("parseAse rejects other and truncated files", () => {
  assert.throws(() => parseAse(new TextEncoder().encode("GIMP Palette")), /swatch/i);
  const good = aseBytes([["Red", "RGB ", [1, 0, 0], 2]]);
  assert.throws(() => parseAse(good.slice(0, good.length - 5)), /swatch/i);
});

test("parseAse rejects color values that are not numbers", () => {
  for (const [model, values] of [
    ["RGB ", [Number.NaN, 0, 0]],
    ["CMYK", [0, 0, 0, Number.POSITIVE_INFINITY]],
    ["LAB ", [Number.NaN, 0, 0]],
    ["Gray", [Number.NaN]],
  ]) {
    assert.throws(() => parseAse(aseBytes([["Bad", model, values, 2]])), /swatch/i, model);
  }
});

test("parseSwatchText reads hex lists and GIMP palettes", () => {
  assert.deepEqual(parseSwatchText("#1f2a3b, ffffff\n#abc nope #12345 #1F2A3B"), [
    "#1F2A3B",
    "#FFFFFF",
    "#AABBCC",
  ]);
  const gpl =
    "GIMP Palette\nName: Brand\nColumns: 4\n#\n255   0   0\tRed\n  0 128 255 Sky\n300 0 0 bad\n";
  assert.deepEqual(parseSwatchText(gpl), ["#FF0000", "#0080FF"]);
  const many = Array.from(
    { length: SWATCHES_MAX + 10 },
    (_, i) => `#${i.toString(16).padStart(6, "0")}`,
  ).join(" ");
  assert.equal(parseSwatchText(many).length, SWATCHES_MAX);
});

test("mapToPalette snaps opaque pixels to the nearest swatch and backfills transparency", () => {
  const img = {
    width: 3,
    height: 1,
    data: new Uint8ClampedArray([250, 10, 5, 255, 20, 20, 240, 255, 1, 2, 3, 0]),
  };
  mapToPalette(img, ["#FF0000", "#0000FF", "#00FF00"]);
  assert.deepEqual([...img.data], [255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 0]);
});

test("reduceAndRemoveBackground uses my colors instead of quantizing", () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4)
    data.set(i < 32 ? [200, 30, 30, 255] : [30, 30, 200, 255], i);
  const img = { width: 4, height: 4, data };
  reduceAndRemoveBackground(img, 256, { swatches: ["#FF0000", "#0000FF"] });
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  assert.deepEqual([...colors].sort(), ["0,0,255", "255,0,0"]);
});

test("sanitizeSettings validates the color source and swatches", () => {
  assert.deepEqual(sanitizeSettings({ colorSource: "custom", swatches: ["#FF0000", "#00ff00"] }), {
    colorSource: "custom",
    swatches: ["#FF0000", "#00ff00"],
  });
  assert.deepEqual(sanitizeSettings({ colorSource: "pantone", swatches: ["red"] }), {});
  assert.deepEqual(
    sanitizeSettings({ swatches: Array.from({ length: SWATCHES_MAX + 1 }, () => "#000000") }),
    {},
  );
});

test("tracePixels keeps pixel settings tuned at 2x the same size at any upscale", () => {
  assert.equal(tracePixels(8, 2), 8);
  assert.equal(tracePixels(8, 4), 16);
  // Below 2x a setting stays in trace pixels, as it was tuned: large
  // sources traced at the size cap never reached 2x.
  assert.equal(tracePixels(8, 1), 8);
  assert.equal(tracePixels(8, 0.7), 8);
  // A set value never rounds away to nothing; 0 stays off.
  assert.equal(tracePixels(1, 0.5), 1);
  assert.equal(tracePixels(0, 4), 0);
});

test("profileColorSettings follows flat art's colors within the profile", () => {
  const profile = EXPORT_PROFILES.detail;
  const solids = [
    [0, 0, 0],
    [60, 0, 0],
    [255, 255, 255],
  ];
  // Flat art: its own color count, Merge kept below its closest pair,
  // the profile's Smallest shape.
  assert.deepEqual(profileColorSettings(profile, { flat: true, colorCount: 3, solids }), {
    colors: 3,
    speckle: profile.speckle,
    layerDiff: Math.min(profile.layerDiff, 30),
  });
  // Never above the profile's own color count.
  const grid = [];
  for (let r = 0; r < 256; r += 51) {
    for (let g = 0; g < 256; g += 51) {
      for (let b = 0; b < 256; b += 51) grid.push([r, g, b]);
    }
  }
  assert.equal(
    profileColorSettings(profile, { flat: true, colorCount: grid.length, solids: grid }).colors,
    profile.colors,
  );
  // Photos keep the profile's values.
  assert.deepEqual(profileColorSettings(profile, { flat: false, colorCount: 256 }), {
    colors: profile.colors,
    speckle: profile.speckle,
    layerDiff: profile.layerDiff,
  });
});

test("Balanced and the detail profiles keep auto-detect on", () => {
  for (const name of ["balanced", "detail", "maxDetail"]) {
    assert.equal(EXPORT_PROFILES[name].autoDetect, true, name);
  }
  for (const name of ["web", "print", "vinyl", "icon", "pixelExact", "monoBlack"]) {
    assert.ok(!EXPORT_PROFILES[name].autoDetect, name);
  }
});

test("despeckleColors merges specks into the color around them", () => {
  const img = makeImage(20, 20, [240, 240, 240, 255]);
  setPixel(img, 5, 5, [200, 30, 30, 255]);
  despeckleColors(img, 3);
  assert.deepEqual(getPixel(img, 5, 5).slice(0, 3), [240, 240, 240]);
});

test("despeckleColors keeps a long thin line on one background", () => {
  // The tracer's own filter drops any region whose perimeter reaches its
  // area, which is every line 2 px wide or thinner, however long.
  const img = makeImage(40, 20, [240, 240, 240, 255]);
  for (let x = 2; x < 38; x++) setPixel(img, x, 10, [0, 0, 0, 255]);
  despeckleColors(img, 4);
  assert.deepEqual(getPixel(img, 20, 10).slice(0, 3), [0, 0, 0]);
});

test("despeckleColors keeps an outline between two different fills", () => {
  const img = makeImage(40, 20, [240, 240, 240, 255]);
  for (let y = 11; y < 20; y++)
    for (let x = 0; x < 40; x++) setPixel(img, x, y, [200, 30, 30, 255]);
  for (let x = 0; x < 40; x++) setPixel(img, x, 10, [0, 0, 0, 255]);
  despeckleColors(img, 4);
  assert.deepEqual(getPixel(img, 20, 10).slice(0, 3), [0, 0, 0]);
});

test("despeckleColors merges a blend sliver between two fills", () => {
  // Color reduction leaves a band of in-between color along an edge.
  const img = makeImage(40, 20, [240, 240, 240, 255]);
  for (let y = 11; y < 20; y++)
    for (let x = 0; x < 40; x++) setPixel(img, x, y, [200, 30, 30, 255]);
  for (let x = 0; x < 40; x++) setPixel(img, x, 10, [220, 135, 135, 255]);
  despeckleColors(img, 4);
  const [r, g, b] = getPixel(img, 20, 10);
  assert.ok(
    (r === 240 && g === 240 && b === 240) || (r === 200 && g === 30 && b === 30),
    `sliver became ${r},${g},${b}`,
  );
});
