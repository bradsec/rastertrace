// Pure pixel and string operations for the rastertrace pipeline.
// Every function here runs in Node (tests) and the browser (worker/app):
// images are plain { data: Uint8ClampedArray, width, height } RGBA buffers.

import {
  colorDistance,
  linearLut,
  oklabInto,
  oklabToSrgb,
  parseHexColor,
  srgbToOklab,
  SWATCHES_MAX,
} from "./color.js?v=1";
import { ALPHA_THRESHOLD, tracePixels } from "./raster.js?v=1";

export const DEFAULTS = Object.freeze({
  autoDetect: true,
  colors: 256,
  speckle: 8,
  layerDiff: 16,
  upscale: "auto",
  mode: "spline",
  cornerThreshold: 60,
  hierarchical: "stacked",
  grayscale: false,
  denoise: false,
  transparent: "",
  fuzz: 16,
  contiguous: false,
  enclosed: false,
  enclosedSize: 16,
  enclosedMaxSize: 512, // ENCLOSED_NO_LIMIT: declared below DEFAULTS
  gradient: false,
  specks: 0,
  edgeTrim: 0,
  edgeSmooth: 0,
  defringe: 0,
  stencil: false,
  stencilThreshold: 128,
  stencilInk: "black",
  pathPrecision: 3,
  lengthThreshold: 6,
  spliceThreshold: 60,
  straighten: 1,
  smoothOutlines: 1,
});

// Keyed by color count. Speckle and layer difference scale inversely:
// fewer colors means flat print-style output, so cleanup gets more
// aggressive; more colors means detail retention matters.
/**
 * @type {Readonly<Record<string, { colors: number, speckle: number, layerDiff: number }>>}
 */
export const PRESETS = Object.freeze({
  2: { colors: 2, speckle: 16, layerDiff: 48 },
  3: { colors: 3, speckle: 16, layerDiff: 32 },
  4: { colors: 4, speckle: 12, layerDiff: 28 },
  6: { colors: 6, speckle: 10, layerDiff: 26 },
  8: { colors: 8, speckle: 8, layerDiff: 24 },
  16: { colors: 16, speckle: 8, layerDiff: 16 },
  32: { colors: 32, speckle: 4, layerDiff: 16 },
  64: { colors: 64, speckle: 4, layerDiff: 12 },
  128: { colors: 128, speckle: 2, layerDiff: 8 },
  // 256 (no quantize/modeFilter pass — see js/worker.js) needs more
  // cleanup than 128, not less: raw source noise reaches the tracer
  // untouched, so despeckle/layer merging stay above the 128 entry
  // instead of continuing to taper off.
  256: { colors: 256, speckle: 3, layerDiff: 10 },
});

// The Simplify slider, like Illustrator's Paths slider: one control over
// both curve-fitting tolerances, from most detail to simplest. Level 3 is
// the default pair, and the detail profiles' pairs are levels too, so a
// profile never shows as Custom.
export const SIMPLIFY_LEVELS = Object.freeze([
  { lengthThreshold: 3.5, spliceThreshold: 10 },
  { lengthThreshold: 4, spliceThreshold: 20 },
  { lengthThreshold: 4, spliceThreshold: 30 },
  { lengthThreshold: 4, spliceThreshold: 45 },
  { lengthThreshold: 6, spliceThreshold: 60 },
  { lengthThreshold: 8, spliceThreshold: 75 },
  { lengthThreshold: 10, spliceThreshold: 90 },
]);

/**
 * Index of the Simplify level with exactly these tolerances, or -1.
 * @param {number} lengthThreshold
 * @param {number} spliceThreshold
 */
export function simplifyLevel(lengthThreshold, spliceThreshold) {
  return SIMPLIFY_LEVELS.findIndex(
    (l) => l.lengthThreshold === lengthThreshold && l.spliceThreshold === spliceThreshold,
  );
}

// The lowest Merge auto-detect sets (sum of RGB channel differences).
// Shades closer than this look the same: kept apart, as a near-black
// outline and a dark background about 10 apart were, their noisy shared
// edge breaks the outline into ragged pieces. Kept low so real nearby
// shades (skin tones, hair highlights) keep their own colors; Smooth
// outlines clears the remaining edge noise.
const DETECTED_MERGE_FLOOR = 12;

/**
 * Color settings auto-detection derives from one image's analyzeFlatness
 * result. Flat art snaps colors to the detected count and takes cleanup
 * from the nearest preset at or above it; photographic sources get the
 * defaults, so a photo loaded after flat art does not inherit its
 * reduced palette.
 *
 * @param {{ flat: boolean, colorCount: number, solids?: number[][] }} analysis
 */
export function detectedColorSettings({ flat, colorCount, solids }) {
  if (!flat) {
    return { colors: DEFAULTS.colors, speckle: DEFAULTS.speckle, layerDiff: DEFAULTS.layerDiff };
  }
  const key = Object.keys(PRESETS)
    .map(Number)
    .sort((a, b) => a - b)
    .find((k) => k >= colorCount);
  const preset = PRESETS[key ?? 256];
  // The tracer merges neighboring layers whose colors differ by no more
  // than Merge, so stay under half the closest pair of detected colors,
  // but no lower than DETECTED_MERGE_FLOOR: shades closer than that look
  // the same, and kept apart their noisy shared edge breaks up outlines.
  let layerDiff = preset.layerDiff;
  if (solids && solids.length > 1) {
    let closest = Infinity;
    for (let i = 0; i < solids.length; i++) {
      for (let j = i + 1; j < solids.length; j++) {
        closest = Math.min(closest, colorDistance(solids[i], solids[j]));
      }
    }
    // The floor wins over the preset too: many-color presets set a low
    // Merge that would keep near-identical shades apart again.
    layerDiff = Math.max(DETECTED_MERGE_FLOOR, Math.min(layerDiff, Math.floor(closest / 2)));
    // Shades within Merge share a color, so they take no slot of their own.
    return {
      colors: distinctColorCount(solids, layerDiff),
      speckle: preset.speckle,
      layerDiff,
    };
  }
  return { colors: colorCount, speckle: preset.speckle, layerDiff };
}

/**
 * Color settings for an auto-detect profile on one image: flat art keeps
 * its own color count (never above the profile's) with Merge below its
 * closest pair of colors; photos keep the profile's values. Smallest
 * shape is always the profile's, as it sets the profile's detail level.
 *
 * @param {{ colors: number, speckle: number, layerDiff: number }} profile
 * @param {{ flat: boolean, colorCount: number, solids?: number[][] }} analysis
 */
export function profileColorSettings(profile, analysis) {
  if (!analysis.flat) {
    return { colors: profile.colors, speckle: profile.speckle, layerDiff: profile.layerDiff };
  }
  const detected = detectedColorSettings(analysis);
  return {
    colors: Math.min(detected.colors, profile.colors),
    speckle: profile.speckle,
    layerDiff: Math.min(detected.layerDiff, profile.layerDiff),
  };
}

/**
 * How many of the detected `solids` (most common first) keep a color of
 * their own once Merge applies: each is dropped when within `layerDiff`
 * of a more common color already kept, as quantize seeds flat art. Never
 * below the Max colors minimum of 2.
 * @param {number[][]} solids
 * @param {number} layerDiff
 */
export function distinctColorCount(solids, layerDiff) {
  return Math.max(2, distinctColors(solids, layerDiff).length);
}

/**
 * The `solids` distinctColorCount keeps, most common first.
 * @param {number[][]} solids
 * @param {number} layerDiff
 */
export function distinctColors(solids, layerDiff) {
  /**
   * @type {number[][]}
   */
  const kept = [];
  for (const color of solids) {
    if (kept.every((other) => colorDistance(color, other) > layerDiff)) kept.push(color);
  }
  return kept;
}

// Purpose-based export profiles (SVG_EXPORT_RESEARCH.md). `autoDetect`
// profiles keep color auto-detection on: flat art takes its own colors
// within the profile (profileColorSettings), photos the profile's values. Values are
// applied to the visible controls like PRESETS: users can edit them
// afterwards. pathPrecision/spliceThreshold feed the tracer directly;
// minify/stencil toggle post-processing and binary color mode.
/**
 * @typedef {{ colors: number, speckle: number, layerDiff: number, mode: string, cornerThreshold: number,
 *   hierarchical: string, pathPrecision: number, upscale: string | number, straighten: number,
 *   minify: boolean, stencil: boolean, autoDetect?: boolean, lengthThreshold?: number,
 *   spliceThreshold?: number, stencilInk?: string, smoothOutlines?: number,
 *   stencilThreshold?: number, denoise?: boolean }} ExportProfile
 * @type {Readonly<Record<string, ExportProfile>>}
 */
export const EXPORT_PROFILES = Object.freeze({
  web: {
    colors: 16,
    speckle: 10,
    layerDiff: 24,
    mode: "spline",
    cornerThreshold: 60,
    hierarchical: "stacked",
    pathPrecision: 1,
    upscale: "auto",
    straighten: 1,
    minify: true,
    stencil: false,
  },
  balanced: {
    colors: 256,
    speckle: 8,
    layerDiff: 16,
    mode: "spline",
    cornerThreshold: 60,
    hierarchical: "stacked",
    pathPrecision: 2,
    upscale: "auto",
    straighten: 0.5,
    minify: false,
    stencil: false,
    autoDetect: true,
  },
  detail: {
    colors: 64,
    speckle: 2,
    layerDiff: 8,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 4,
    lengthThreshold: 4,
    spliceThreshold: 30,
    upscale: "auto",
    straighten: 0,
    minify: false,
    stencil: false,
    autoDetect: true,
  },
  maxDetail: {
    colors: 128,
    speckle: 1,
    layerDiff: 6,
    mode: "spline",
    cornerThreshold: 25,
    hierarchical: "stacked",
    pathPrecision: 4,
    lengthThreshold: 4,
    spliceThreshold: 20,
    upscale: "auto",
    straighten: 0,
    minify: false,
    stencil: false,
    autoDetect: true,
  },
  // mode "none" (below) skips all curve/corner simplification, so colors
  // are the only lever bounding path count. Speckle must be 0: at any other
  // value the tracer drops every region whose perimeter is at least its
  // area, which is every lone pixel and block up to 4x4, the very detail
  // pixel art is made of. Upscale 1: pixel edges need no resampling, and
  // each source pixel stays one trace pixel. 16 colors covers most pixel
  // art palettes; a photographic source still explodes (measured: a
  // 1.92 MP noisy source gave 154,902 paths / 17 MB in 3.8s at 16 colors)
  // but stays traceable, where 64 colors risked a tab crash.
  pixelExact: {
    colors: 16,
    speckle: 0,
    layerDiff: 6,
    mode: "none",
    cornerThreshold: 60,
    hierarchical: "stacked",
    pathPrecision: 4,
    lengthThreshold: 4,
    spliceThreshold: 45,
    upscale: 1,
    straighten: 0,
    smoothOutlines: 0,
    minify: false,
    stencil: false,
  },
  print: {
    colors: 8,
    speckle: 12,
    layerDiff: 28,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 3,
    upscale: "auto",
    straighten: 1,
    minify: false,
    stencil: false,
  },
  monoBlack: {
    colors: 2,
    speckle: 6,
    layerDiff: 48,
    mode: "spline",
    cornerThreshold: 25,
    hierarchical: "stacked",
    pathPrecision: 4,
    upscale: "auto",
    straighten: 1,
    minify: false,
    stencil: true,
    stencilInk: "black",
  },
  monoWhite: {
    colors: 2,
    speckle: 6,
    layerDiff: 48,
    mode: "spline",
    cornerThreshold: 25,
    hierarchical: "stacked",
    pathPrecision: 4,
    upscale: "auto",
    straighten: 1,
    minify: false,
    stencil: true,
    stencilInk: "white",
  },
  laser: {
    colors: 2,
    speckle: 12,
    layerDiff: 48,
    mode: "spline",
    cornerThreshold: 30,
    hierarchical: "stacked",
    pathPrecision: 3,
    upscale: "auto",
    straighten: 1.5,
    minify: false,
    stencil: true,
  },
  // Multi-color vinyl (Cricut, Silhouette, plotters): Cutout layering
  // makes each color its own pieces with no overlap, so layers weed and
  // stack cleanly; strong despeckle spares tiny pieces nobody can weed.
  vinyl: {
    colors: 6,
    speckle: 16,
    layerDiff: 28,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "cutout",
    pathPrecision: 3,
    upscale: "auto",
    straighten: 1.5,
    minify: false,
    stencil: false,
  },
  // Scanned sketches and ink drawings: denoise clears paper grain before
  // the threshold, and a lighter threshold than 128 keeps pencil strokes.
  lineArt: {
    colors: 2,
    speckle: 8,
    layerDiff: 48,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 3,
    upscale: "auto",
    straighten: 0.5,
    minify: false,
    stencil: true,
    stencilInk: "black",
    stencilThreshold: 180,
    denoise: true,
  },
  // Logos and icons: flat colors, crisp corners, long straight runs and
  // few nodes, minified for the smallest file.
  icon: {
    colors: 8,
    speckle: 10,
    layerDiff: 24,
    mode: "spline",
    cornerThreshold: 45,
    hierarchical: "stacked",
    pathPrecision: 1,
    lengthThreshold: 6,
    spliceThreshold: 60,
    upscale: "auto",
    straighten: 2,
    minify: true,
    stencil: false,
  },
});

/**
 * Cut every pixel to pure black or white: r below the threshold goes
 * black, everything else white. Alpha is untouched. Run after
 * toGrayscale so r is luma; this makes the stencil threshold a user
 * control instead of vtracer's fixed cut at 128.
 * @param {ImageData} img
 * @param {number} threshold
 */
export function thresholdImage(img, threshold) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] < threshold ? 0 : 255;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
}

/**
 * Paint pixels below the alpha threshold with the given opaque color.
 * Binary (stencil) tracing keys on brightness only and ignores alpha, so
 * transparent areas must become background-colored before the trace.
 * @param {ImageData} img
 * @param {number[]} rgb
 */
export function fillTransparent(img, [r, g, b]) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < ALPHA_THRESHOLD) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
}

// Validators for persisted settings. localStorage is untrusted input:
// each entry admits one control's value range and nothing else.
/**
 * @param {unknown} value
 */
export function physicalWidthValue(value) {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 && width <= 100000 ? width : null;
}

/**
 * @type {Record<string, (v: any) => boolean>}
 */
const SETTING_CHECKS = {
  profile: (v) =>
    v === "" || v in EXPORT_PROFILES || (typeof v === "string" && userPresetName(v) !== null),
  preset: (v) => typeof v === "string",
  autoDetect: (v) => typeof v === "boolean",
  colors: (v) => Number.isFinite(v) && v >= 2 && v <= 256,
  speckle: (v) => Number.isFinite(v) && v >= 0 && v <= 32,
  layerDiff: (v) => Number.isFinite(v) && v >= 0 && v <= 128,
  cornerThreshold: (v) => Number.isFinite(v) && v >= 0 && v <= 120,
  hierarchical: (v) => v === "stacked" || v === "cutout",
  upscale: (v) => [1, 2, 3, 4, "auto", "ultra"].includes(v),
  mode: (v) => ["spline", "polygon", "none"].includes(v),
  grayscale: (v) => typeof v === "boolean",
  denoise: (v) => typeof v === "boolean",
  stencil: (v) => typeof v === "boolean",
  stencilThreshold: (v) => Number.isFinite(v) && v >= 1 && v <= 254,
  stencilInk: (v) => v === "black" || v === "white",
  transparent: (v) => ["", "edges", "auto", "custom"].includes(v),
  knockoutColor: (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v),
  fuzz: (v) => Number.isFinite(v) && v >= 0 && v <= 255,
  contiguous: (v) => typeof v === "boolean",
  enclosed: (v) => typeof v === "boolean",
  enclosedSize: (v) => Number.isFinite(v) && v >= 1 && v <= 64,
  enclosedMaxSize: (v) => Number.isFinite(v) && v >= 8 && v <= ENCLOSED_NO_LIMIT,
  gradient: (v) => typeof v === "boolean",
  specks: (v) => Number.isFinite(v) && v >= 0 && v <= 16,
  edgeTrim: (v) => Number.isFinite(v) && v >= 0 && v <= 16,
  edgeSmooth: (v) => Number.isFinite(v) && v >= 0 && v <= 8,
  defringe: (v) => Number.isFinite(v) && v >= 0 && v <= 8,
  pathPrecision: (v) => Number.isFinite(v) && v >= 1 && v <= 4,
  lengthThreshold: (v) => Number.isFinite(v) && v >= 3.5 && v <= 10,
  spliceThreshold: (v) => Number.isFinite(v) && v >= 10 && v <= 90,
  straighten: (v) => Number.isFinite(v) && v >= 0 && v <= 16,
  smoothOutlines: (v) => Number.isInteger(v) && v >= 0 && v <= 4,
  exportSize: (v) => v === "px" || v === "physical",
  physicalWidth: (v) => typeof v === "number" && physicalWidthValue(v) !== null,
  physicalUnit: (v) => ["px", "mm", "cm", "in"].includes(v),
  minify: (v) => typeof v === "boolean",
  colorSource: (v) => v === "auto" || v === "custom",
  swatches: (v) =>
    Array.isArray(v) &&
    v.length <= SWATCHES_MAX &&
    v.every((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)),
};

/**
 * Reduce a parsed settings snapshot (e.g. from localStorage) to known
 * keys with in-range values. Anything unknown or invalid is dropped.
 * @param {any} raw untrusted, e.g. parsed JSON
 * @returns {Record<string, any>}
 */
export function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, check] of Object.entries(SETTING_CHECKS)) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && check(raw[key])) {
      out[key] = raw[key];
    }
  }
  return out;
}

export const PRESET_NAME_MAX = 40;
export const PRESETS_MAX = 50;
/** Export profile select value for a saved user preset. */
export const USER_PRESET_PREFIX = "user:";
// A preset stands in for the profile select and turns color auto-detection
// off when applied, so neither is stored inside it.
const PRESET_SESSION_KEYS = ["profile", "autoDetect"];

/**
 * Trimmed preset name without control characters, or null when unusable.
 * @param {unknown} value
 */
export function presetName(value) {
  if (typeof value !== "string") return null;
  // oxlint-disable-next-line no-control-regex -- stripping them is the point
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name && name.length <= PRESET_NAME_MAX ? name : null;
}

/**
 * Preset name from a "user:<name>" profile value, or null.
 * @param {string} profile
 */
export function userPresetName(profile) {
  return profile.startsWith(USER_PRESET_PREFIX)
    ? presetName(profile.slice(USER_PRESET_PREFIX.length))
    : null;
}

/**
 * @param {string} a
 * @param {string} b
 */
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Validate saved or imported presets: a bare array or an export file's
 * { presets }. Names compare case-insensitively and the first one wins;
 * each preset's settings pass sanitizeSettings. Capped at PRESETS_MAX.
 * @returns {{ name: string, settings: object }[]}
 * @param {any} raw untrusted, e.g. parsed JSON
 */
export function sanitizePresets(raw) {
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.presets) ? raw.presets : [];
  /** @type {{ name: string, settings: Record<string, any> }[]} */
  const out = [];
  for (const entry of entries) {
    if (out.length >= PRESETS_MAX) break;
    const name = presetName(entry?.name);
    if (!name || out.some((p) => sameName(p.name, name))) continue;
    const settings = sanitizeSettings(entry.settings);
    for (const key of PRESET_SESSION_KEYS) delete settings[key];
    out.push({ name, settings });
  }
  return out;
}

/**
 * Add `incoming` presets to `list` without mutating it. A same-named
 * preset is replaced in place (or skipped with replace: false); new names
 * append while the list is under PRESETS_MAX.
 * @param {{ name: string, settings: object }[]} list
 * @param {{ name: string, settings: object }[]} incoming
 * @param {{ replace?: boolean }} [options]
 */
export function mergePresets(list, incoming, { replace = true } = {}) {
  const presets = [...list];
  const added = [];
  const replaced = [];
  const skipped = [];
  for (const preset of incoming) {
    const index = presets.findIndex((p) => sameName(p.name, preset.name));
    if (index >= 0 && replace) {
      presets[index] = preset;
      replaced.push(preset.name);
    } else if (index < 0 && presets.length < PRESETS_MAX) {
      presets.push(preset);
      added.push(preset.name);
    } else {
      skipped.push(preset.name);
    }
  }
  return { presets, added, replaced, skipped };
}

/**
 * Dominant border color, or null when the border is mostly transparent.
 * Samples the border ring plus 4x4 corner patches and bins samples
 * coarsely (16 levels per channel), returning the average color of the
 * dominant bin: single corner pixels are one JPEG artifact or watermark
 * away from the wrong answer, and binning absorbs compression noise.
 * @returns {[number, number, number] | null}
 * @param {ImageData} img
 */
export function detectBackgroundColor(img) {
  const { data, width, height } = img;
  /**
   * @type {number[]} byte offsets of sampled pixels
   */
  const samples = [];
  let total = 0;
  /**
   * @param {number} x
   * @param {number} y
   */
  const take = (x, y) => {
    total += 1;
    const i = (y * width + x) * 4;
    if (data[i + 3] >= ALPHA_THRESHOLD) samples.push(i);
  };
  const stride = Math.max(1, Math.floor((2 * (width + height)) / 2048));
  for (let x = 0; x < width; x += stride) {
    take(x, 0);
    take(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += stride) {
    take(0, y);
    take(width - 1, y);
  }
  const k = Math.min(4, width, height);
  for (const [cx, cy] of [
    [0, 0],
    [width - k, 0],
    [0, height - k],
    [width - k, height - k],
  ]) {
    for (let y = cy; y < cy + k; y++) {
      for (let x = cx; x < cx + k; x++) take(x, y);
    }
  }
  // Mostly transparent border: any opaque border pixels are subject, not
  // background.
  if (samples.length < total / 2) return null;

  /**
   * @param {number} i
   */
  const bin = (i) => ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
  const bins = new Map();
  let bestKey = -1;
  let bestCount = 0;
  for (const i of samples) {
    const key = bin(i);
    const n = (bins.get(key) || 0) + 1;
    bins.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      bestKey = key;
    }
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const i of samples) {
    if (bin(i) !== bestKey) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Fuzz-scale distance between two Oklab colors (see makeFuzzMatch).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
function fuzzDistance(a, b) {
  const dL = a[0] - b[0];
  const dA = (a[1] - b[1]) * 2;
  const dB = (a[2] - b[2]) * 2;
  return Math.sqrt(dL * dL + dA * dA + dB * dB) * 255;
}

/**
 * Perceptual fuzz matcher: chroma-weighted Oklab distance to `target`,
 * scaled so 0-255 fuzz values stay comparable to the old per-channel
 * scale. Doubling the a/b (chroma) axes keeps hue shifts (subject edges)
 * protected while letting pure lightness noise (shadows, JPEG artifacts)
 * count as background. Allocation-free per call: runs per pixel, and
 * remembers the last color, since flat art repeats it along whole runs.
 * @param {number[]} target
 * @param {number} fuzz
 */
function makeFuzzMatch(target, fuzz) {
  const [L1, A1, B1] = srgbToOklab(target);
  const lut = linearLut();
  let lastKey = -1;
  let lastResult = false;
  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (key === lastKey) return lastResult;
    lastKey = key;
    const lr = lut[r];
    const lg = lut[g];
    const lb = lut[b];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const dL = L1 - (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s);
    const dA = (A1 - (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s)) * 2;
    const dB = (B1 - (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s)) * 2;
    lastResult = Math.sqrt(dL * dL + dA * dA + dB * dB) * 255 <= fuzz;
    return lastResult;
  };
}

/**
 * Set alpha to 0 wherever the image matches color within fuzz
 * (perceptual distance, see makeFuzzMatch). Mutates img in place.
 * @param {ImageData} img
 * @param {number[]} color
 * @param {number} fuzz
 */
export function knockOutColor(img, color, fuzz) {
  const { data } = img;
  const matches = makeFuzzMatch(color, fuzz);
  for (let i = 0; i < data.length; i += 4) {
    if (matches(data[i], data[i + 1], data[i + 2])) data[i + 3] = 0;
  }
  return img;
}

/**
 * Enclosed-area limit in trace pixels: `size` source pixels across,
 * squared at the trace `scale`. The "enclosed" option removes regions
 * between a user-set minimum and maximum, because no fixed limit
 * separates letter counters (small) from same-color subject areas such
 * as a blank screen (large).
 * @param {number} size
 * @param {number} scale
 */
export function enclosedAreaLimit(size, scale) {
  return Math.max(1, Math.round((size * scale) ** 2));
}

/** Largest-enclosed-area slider value that means "no maximum". */
export const ENCLOSED_NO_LIMIT = 512;

/**
 * Gradient flood limits, as multiples of fuzz. A real backdrop gradient
 * changes by a fraction of a unit per pixel; what the step limit must
 * reject is the jump across a subject edge. The drift cap bounds how far
 * a chain of small steps can wander from the seed, so a soft,
 * low-contrast edge cannot carry the fill through the whole subject.
 */
const GRADIENT_STEP_SCALE = 0.5;
const GRADIENT_DRIFT_SCALE = 4;

/**
 * Flood-fill knockout: zero the alpha of every pixel CONNECTED to the
 * image border whose color matches `color` within fuzz (perceptual
 * distance). Pixels of the same color inside the subject stay opaque
 * because they are not connected to the edge, unless `enclosedMinArea` is
 * positive: then enclosed matching regions of at least that many pixels,
 * and at most `enclosedMaxArea` (letter counters, gaps between shapes),
 * are removed too. With
 * `gradient`, the fill spreads by small steps between neighbors instead
 * of matching the seed directly, so vignettes and lit backdrops go too
 * (see GRADIENT_STEP_SCALE); enclosed regions still match the seed.
 * Mutates img in place.
 * @param {ImageData} img
 * @param {number[]} color
 * @param {number} fuzz
 * @param {number} enclosedMinArea
 * @param {{ gradient?: boolean, enclosedMaxArea?: number }} [options]
 */
export function knockOutConnected(
  img,
  color,
  fuzz,
  enclosedMinArea = 0,
  { gradient = false, enclosedMaxArea = Infinity } = {},
) {
  const { data, width, height } = img;
  const fuzzMatch = makeFuzzMatch(color, fuzz);
  /**
   * @param {number} i
   */
  const matches = (i) =>
    data[i + 3] >= ALPHA_THRESHOLD && fuzzMatch(data[i], data[i + 1], data[i + 2]);

  // Gradient mode: a neighbor joins when it is within the step limit of
  // the pixel it was reached from and within the drift cap of the seed.
  const lut = linearLut();
  const seedLab = srgbToOklab(color);
  const fromLab = new Float64Array(3);
  const toLab = new Float64Array(3);
  const stepLimit = fuzz * GRADIENT_STEP_SCALE;
  const driftLimit = fuzz * GRADIENT_DRIFT_SCALE;
  /**
   * @param {ArrayLike<number>} from Oklab color of the pixel the fill came from
   * @param {number} i
   */
  const steps = (from, i) => {
    if (data[i + 3] < ALPHA_THRESHOLD) return false;
    oklabInto(lut, data[i], data[i + 1], data[i + 2], toLab);
    return fuzzDistance(fromLab, toLab) <= stepLimit && fuzzDistance(seedLab, toLab) <= driftLimit;
  };

  const stack = new Uint32Array(width * height);
  let stackSize = 0;
  /**
   * @param {number} p
   */
  const take = (p) => {
    data[p * 4 + 3] = 0;
    stack[stackSize++] = p;
  };
  /**
   * @param {number} x
   * @param {number} y
   */
  const seedPush = (x, y) => {
    const p = y * width + x;
    if (matches(p * 4)) take(p);
  };
  for (let x = 0; x < width; x++) {
    seedPush(x, 0);
    seedPush(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seedPush(0, y);
    seedPush(width - 1, y);
  }
  while (stackSize) {
    const p = stack[--stackSize];
    const x = p % width;
    const y = (p / width) | 0;
    if (gradient) {
      // Alpha is already 0 on taken pixels; their color is intact.
      const i = p * 4;
      oklabInto(lut, data[i], data[i + 1], data[i + 2], fromLab);
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]) {
        if (q >= 0 && steps(fromLab, q * 4)) take(q);
      }
    } else {
      if (x > 0) seedPush(x - 1, y);
      if (x < width - 1) seedPush(x + 1, y);
      if (y > 0) seedPush(x, y - 1);
      if (y < height - 1) seedPush(x, y + 1);
    }
  }
  if (enclosedMinArea <= 0) return img;

  // Everything still matching is enclosed. Label each region; the BFS
  // queue doubles as the member list, so a region's pixels sit in
  // stack[0..size) when its search ends.
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !matches(start * 4)) continue;
    seen[start] = 1;
    stack[0] = start;
    let size = 1;
    for (let head = 0; head < size; head++) {
      const p = stack[head];
      const x = p % width;
      const y = (p / width) | 0;
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]) {
        if (q >= 0 && !seen[q] && matches(q * 4)) {
          seen[q] = 1;
          stack[size++] = q;
        }
      }
    }
    if (size >= enclosedMinArea && size <= enclosedMaxArea) {
      for (let k = 0; k < size; k++) data[stack[k] * 4 + 3] = 0;
    }
  }
  return img;
}

/**
 * Edge knockout seeded by the detected border color (see
 * detectBackgroundColor and knockOutConnected). Returns the seed color,
 * or null when the border is already transparent. Mutates img in place.
 * @param {ImageData} img
 * @param {number} fuzz
 * @param {number} enclosedMinArea
 * @param {{ gradient?: boolean, enclosedMaxArea?: number }} [options]
 */
export function knockOutEdges(
  img,
  fuzz,
  enclosedMinArea = 0,
  { gradient = false, enclosedMaxArea = Infinity } = {},
) {
  const seed = detectBackgroundColor(img);
  if (!seed) return null;
  knockOutConnected(img, seed, fuzz, enclosedMinArea, { gradient, enclosedMaxArea });
  return seed;
}

/**
 * Nearest opaque color in the image to target (max per-channel distance),
 * or null when nothing is within maxDistance. Intended for quantized
 * images, where snapping the knockout color to the palette removes the
 * whole cluster instead of only pixels inside the fuzz radius.
 * @param {ImageData} img
 * @param {number[]} rgb
 * @param {number} maxDistance
 */
export function snapToImageColor(img, [r, g, b], maxDistance) {
  const { data } = img;
  const seen = new Set();
  /** @type {[number, number, number] | null} */
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    const d = Math.max(Math.abs(data[i] - r), Math.abs(data[i + 1] - g), Math.abs(data[i + 2] - b));
    if (d < bestDist) {
      bestDist = d;
      best = [data[i], data[i + 1], data[i + 2]];
    }
  }
  return bestDist <= maxDistance ? best : null;
}

/**
 * Apply the selected background-removal mode. `transparent` is "edges",
 * "auto", an [r, g, b] color, or null/"" for none. For quantized images
 * the target snaps to the nearest palette color so the whole flat
 * cluster goes; fuzz still applies around the snapped color, because an
 * anti-aliased boundary quantizes into several near-background shades
 * that would otherwise survive as a halo outline around the subject.
 * `contiguous` limits a picked color to regions connected to the border,
 * like edges mode; a positive `enclosedMinArea` then also removes
 * enclosed regions of at least that many pixels and at most
 * `enclosedMaxArea` (edges and contiguous only), and `gradient` lets those modes follow a gradient backdrop (see
 * knockOutConnected). Returns the removed color, or null when nothing
 * was removed.
 * @param {ImageData} img
 * @param {string | number[]} transparent "auto", "edges" or an [r, g, b] color
 * @param {number} fuzz
 * @param {boolean} quantized
 * @param {{ contiguous?: boolean, enclosedMinArea?: number, enclosedMaxArea?: number, gradient?: boolean }} [options]
 */
export function removeBackground(
  img,
  transparent,
  fuzz,
  quantized,
  { contiguous = false, enclosedMinArea = 0, enclosedMaxArea = Infinity, gradient = false } = {},
) {
  if (transparent === "edges") {
    return knockOutEdges(img, fuzz, enclosedMinArea, { gradient, enclosedMaxArea });
  }
  /** @type {[number, number, number] | null} */
  let target = null;
  if (transparent === "auto") target = detectBackgroundColor(img);
  else if (Array.isArray(transparent))
    target = /** @type {[number, number, number]} */ (transparent);
  if (!target) return null;
  let color = target;
  if (quantized) {
    const snapped = snapToImageColor(img, target, Math.max(fuzz, 48));
    if (snapped) color = snapped;
  }
  if (contiguous && Array.isArray(transparent)) {
    knockOutConnected(img, color, fuzz, enclosedMinArea, { gradient, enclosedMaxArea });
  } else {
    knockOutColor(img, color, fuzz);
  }
  return color;
}

/**
 * After a knockout made before quantizing: clear opaque pixels along the
 * cutout that looked more like the background than like the palette
 * color they were quantized to. Those are anti-aliased blends that the
 * knockout's fuzz missed; without a background palette slot to absorb
 * them they would trace as an outline. `original` holds the colors from
 * before quantizing. Grows at most `rings` pixels in from the cutout, and
 * only through reclaimed pixels, so the subject cannot be eaten.
 * Mutates img in place.
 * @param {ImageData} img
 * @param {Uint8ClampedArray} original
 * @param {number[]} seed
 * @param {number} rings
 */
export function reclaimFringe(img, original, seed, rings) {
  const { data, width, height } = img;
  const lut = linearLut();
  const seedLab = srgbToOklab(seed);
  const was = new Float64Array(3);
  const now = new Float64Array(3);
  for (let ring = 0; ring < rings; ring++) {
    const clear = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i = p * 4;
        if (data[i + 3] < ALPHA_THRESHOLD) continue;
        if (
          !(
            (x > 0 && data[i - 4 + 3] < ALPHA_THRESHOLD) ||
            (x < width - 1 && data[i + 4 + 3] < ALPHA_THRESHOLD) ||
            (y > 0 && data[i - width * 4 + 3] < ALPHA_THRESHOLD) ||
            (y < height - 1 && data[i + width * 4 + 3] < ALPHA_THRESHOLD)
          )
        ) {
          continue;
        }
        oklabInto(lut, original[i], original[i + 1], original[i + 2], was);
        oklabInto(lut, data[i], data[i + 1], data[i + 2], now);
        if (fuzzDistance(was, seedLab) < fuzzDistance(was, now)) clear.push(i);
      }
    }
    if (clear.length === 0) break;
    for (const i of clear) data[i + 3] = 0;
  }
  return img;
}

/** How far reclaimFringe may reach into the subject, in pixels. */
export const FRINGE_RINGS = 2;

/**
 * Color reduction (when `colors` < 256) plus background removal, in the
 * order each mode needs. Border-connected modes (edges, contiguous pick)
 * build the mask BEFORE quantizing: a light subject edge that shares the
 * background's palette slot would otherwise let the flood leak into the
 * subject; reclaimFringe then clears the blend fringe the earlier mask
 * leaves. Global color modes quantize first so off-white highlights that
 * collapse into the background's palette slot go with it ("N colors
 * where one is transparent"). `background` holds transparent, fuzz,
 * contiguous and gradient as removeBackground takes them, plus enclosed,
 * enclosedSize and enclosedMaxSize (source pixels across;
 * ENCLOSED_NO_LIMIT for no maximum) and scale (trace pixels per source
 * pixel) for the enclosed-area limits. `flatArt` (the source was
 * detected as flat art) repairs soft edges even when the palette was
 * clustered rather than seeded.
 * Returns the removed color, or null. Mutates img in place.
 * @param {(label: string) => void} [stage] progress reporter
 * @param {ImageData} img
 * @param {number} colors
 * @param {Record<string, any>} background
 */
export function reduceAndRemoveBackground(img, colors, background, stage = () => {}) {
  const {
    transparent,
    fuzz,
    contiguous = false,
    enclosed = false,
    enclosedSize = DEFAULTS.enclosedSize,
    enclosedMaxSize = DEFAULTS.enclosedMaxSize,
    gradient = false,
    scale = 1,
    swatches = null,
    layerDiff = 0,
    seeds = null,
    keep = null,
    flatArt = false,
  } = background;
  const options = {
    contiguous,
    enclosedMinArea: enclosed ? enclosedAreaLimit(enclosedSize, scale) : 0,
    enclosedMaxArea:
      enclosedMaxSize >= ENCLOSED_NO_LIMIT ? Infinity : enclosedAreaLimit(enclosedMaxSize, scale),
    gradient,
  };
  const custom = Array.isArray(swatches) && swatches.length > 0;
  const quantized = custom || colors < 256;
  const reduce = () => {
    const before = new Uint8ClampedArray(img.data);
    // Soft edges only snap to a wrong third color when the palette is a
    // few flat colors; photo palettes would pay seconds for nothing.
    let flat = custom;
    if (custom) {
      stage("Matching your colors…");
      mapToPalette(img, swatches);
    } else {
      stage(`Reducing to ${colors} colors…`);
      const result = quantize(img, colors, { layerDiff, seeds, keep });
      // Nothing remapped means no dither to clean: lone pixels are detail.
      if (!result) return;
      // Compressed flat art clusters without seeds (Colors set by hand),
      // but its edges blur all the same.
      flat = result === "flat" || flatArt;
    }
    // Only upscaled art has soft edges to repair: at its own size or
    // scaled down, edges are a pixel or two wide, which nearest-color
    // snapping already splits, and repairing them only steps diagonals.
    if (flat && scale > 1) unblendEdges(img, before, tracePixels(BLEND_REACH, scale));
    modeFilter(img);
  };
  const connected = transparent === "edges" || (Array.isArray(transparent) && contiguous);
  if (quantized && connected) {
    stage("Removing background…");
    const seed = removeBackground(img, transparent, fuzz, false, options);
    const original = seed ? new Uint8ClampedArray(img.data) : null;
    reduce();
    if (seed && original) reclaimFringe(img, original, seed, FRINGE_RINGS);
    return seed;
  }
  if (quantized) reduce();
  if (!transparent) return null;
  stage("Removing background…");
  return removeBackground(img, transparent, fuzz, quantized, options);
}

/**
 * Speck cleanup after a knockout: clear opaque islands and fill enclosed
 * transparent pinholes smaller than `size` x `size` pixels (the same area
 * rule as the tracer's speckle filter). A pinhole takes the most common
 * opaque color around it, so quantized images keep their palette.
 * Transparent regions touching the border are background, never holes.
 * 4-connected. Mutates img in place.
 * @param {ImageData} img
 * @param {number} size
 */
export function removeSpecks(img, size) {
  const maxArea = size * size;
  if (maxArea <= 1) return img;
  const { data, width, height } = img;
  const n = width * height;
  /**
   * @param {number} p
   */
  const opaque = (p) => data[p * 4 + 3] >= ALPHA_THRESHOLD;
  const seen = new Uint8Array(n);
  const queue = new Uint32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const isOpaque = opaque(start);
    seen[start] = 1;
    queue[0] = start;
    let count = 1;
    let touchesBorder = false;
    // Neighbor colors across the region boundary, for pinhole fill.
    const around = new Map();
    for (let head = 0; head < count; head++) {
      const p = queue[head];
      const x = p % width;
      const y = (p / width) | 0;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]) {
        if (q < 0) continue;
        if (opaque(q) !== isOpaque) {
          if (!isOpaque && count < maxArea) {
            const j = q * 4;
            const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
            around.set(key, (around.get(key) || 0) + 1);
          }
          continue;
        }
        if (!seen[q]) {
          seen[q] = 1;
          queue[count++] = q;
        }
      }
    }
    if (count >= maxArea) continue;
    if (isOpaque) {
      for (let k = 0; k < count; k++) data[queue[k] * 4 + 3] = 0;
    } else if (!touchesBorder && around.size) {
      let fill = 0;
      let best = -1;
      for (const [key, c] of around) {
        if (c > best) {
          best = c;
          fill = key;
        }
      }
      for (let k = 0; k < count; k++) {
        const i = queue[k] * 4;
        data[i] = (fill >> 16) & 0xff;
        data[i + 1] = (fill >> 8) & 0xff;
        data[i + 2] = fill & 0xff;
        data[i + 3] = 255;
      }
    }
  }
  return img;
}

// unblendEdges: how far (source px) a pixel looks for the two fills a
// soft edge blends, and how close (RGB) a color must sit to the segment
// between two fills to count as their blend.
const BLEND_REACH = 20;
const BLEND_TOLERANCE = 24;
// A pixel this close (RGB) to its fill is solid, not a blend, and a
// pixel weighs at most this many nearby fills as blend ends.
const BLEND_MATCH = 10;
const BLEND_CANDIDATES = 8;
// A fill this close (share of the way) to either end of a blend counts
// as a shade of that end, not a gradient band.
const BLEND_BAND_END = 0.15;

/**
 * Soft-edge repair after color reduction. A blurred or anti-aliased edge
 * between two fills holds blends of them, and snapping each blend to the
 * nearest palette color can land on a third color (a navy and cream blur
 * turns teal), leaving a stripe of it along the edge. Each palette color
 * stands for its fill: the original color most of its pixels had, which
 * My colors swatches can differ from. A pixel whose original color is a
 * blend of two fills found within `reach` pixels, and closer to that
 * blend than to its own fill, takes the palette color of the one its
 * blend leans to, so the edge splits where the mix crosses half. Real
 * outlines (the original matches its fill) and gradient bands (its fill
 * is itself between the two) stay. `original` holds the colors before
 * reduction. Mutates img.
 * @param {ImageData} img
 * @param {Uint8ClampedArray} original
 * @param {number} reach
 */
export function unblendEdges(img, original, reach) {
  if (reach < 1) return img;
  const { data, width, height } = img;
  const n = width * height;
  // Every step near the pixel, then growing by half: a ray only has to
  // cross the blend band and land on the fill beyond it, and upscaled
  // sources stretch `reach` to dozens of pixels.
  const steps = [];
  for (let step = 1; step <= reach; step = step < 4 ? step + 1 : Math.ceil(step * 1.5)) {
    steps.push(step);
  }
  if (steps.at(-1) !== reach) steps.push(reach);
  const stepCount = steps.length;
  const directions = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
  // Pixels by palette index, tallying original colors per index. Flat
  // art repeats each pair along a row, so runs are counted, not pixels.
  const ids = new Int32Array(n);
  const paletteIds = new Map();
  const palette = [];
  const tally = new Map();
  const COLOR = 0x1000000;
  let lastKey = -1;
  let lastId = -1;
  let runPair = -1;
  let runLength = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (data[i + 3] < ALPHA_THRESHOLD) {
      ids[p] = -1;
      continue;
    }
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (key !== lastKey) {
      lastKey = key;
      lastId = paletteIds.get(key) ?? -1;
      if (lastId === -1) {
        lastId = palette.length;
        paletteIds.set(key, lastId);
        palette.push(key);
      }
    }
    ids[p] = lastId;
    const pair = lastId * COLOR + ((original[i] << 16) | (original[i + 1] << 8) | original[i + 2]);
    if (pair === runPair) {
      runLength++;
      continue;
    }
    if (runLength) tally.set(runPair, (tally.get(runPair) || 0) + runLength);
    runPair = pair;
    runLength = 1;
  }
  if (runLength) tally.set(runPair, (tally.get(runPair) || 0) + runLength);
  const fills = new Int32Array(palette.length);
  const fillCounts = new Float64Array(palette.length);
  for (const [pair, count] of tally) {
    const id = Math.floor(pair / COLOR);
    if (count > fillCounts[id]) {
      fillCounts[id] = count;
      fills[id] = pair % COLOR;
    }
  }
  // Solid pixels match their fill: the colors a blend can mix. Blend
  // pixels, whatever color they snapped to, are never ends, and in flat
  // art they are the only pixels left to look at.
  // Squared distances throughout: Math.hypot is slow in WebKit.
  const match2 = BLEND_MATCH * BLEND_MATCH;
  const tolerance2 = BLEND_TOLERANCE * BLEND_TOLERANCE;
  const solid = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (ids[p] === -1) continue;
    const i = p * 4;
    const fill = fills[ids[p]];
    const dr = original[i] - ((fill >> 16) & 0xff);
    const dg = original[i + 1] - ((fill >> 8) & 0xff);
    const db = original[i + 2] - (fill & 0xff);
    if (dr * dr + dg * dg + db * db <= match2) solid[p] = 1;
  }
  // Rays read ids, so writing data as we go cannot feed later pixels.
  const seen = new Int32Array(BLEND_CANDIDATES);
  for (let p = 0; p < n; p++) {
    const own = ids[p];
    if (own === -1 || solid[p]) continue;
    const i = p * 4;
    const or = original[i];
    const og = original[i + 1];
    const ob = original[i + 2];
    const ownFill = fills[own];
    const cr = (ownFill >> 16) & 0xff;
    const cg = (ownFill >> 8) & 0xff;
    const cb = ownFill & 0xff;
    const ownDistance2 = (or - cr) ** 2 + (og - cg) ** 2 + (ob - cb) ** 2;
    const x0 = p % width;
    const y0 = (p - x0) / width;
    let count = 0;
    for (let d = 0; d < 16 && count < BLEND_CANDIDATES; d += 2) {
      const dx = directions[d];
      const dy = directions[d + 1];
      // Indexed: for-of over an array is several times slower in WebKit.
      for (let k = 0; k < stepCount; k++) {
        const step = steps[k];
        const x = x0 + dx * step;
        const y = y0 + dy * step;
        if (x < 0 || y < 0 || x >= width || y >= height) break;
        const q = y * width + x;
        const id = ids[q];
        if (id === -1) break;
        // Keep walking past the first fill: a blend shade the palette
        // picked up can sit between this pixel and the real fill.
        if (!solid[q] || id === own) continue;
        let known = false;
        for (let m = 0; m < count; m++) if (seen[m] === id) known = true;
        if (!known) seen[count++] = id;
        if (count === BLEND_CANDIDATES) break;
      }
    }
    if (count < 2) continue;
    let bestResidual2 = Math.min(ownDistance2, tolerance2);
    let pick = own;
    for (let m = 0; m < count; m++) {
      const a = fills[seen[m]];
      const ar = (a >> 16) & 0xff;
      const ag = (a >> 8) & 0xff;
      const ab = a & 0xff;
      for (let j = m + 1; j < count; j++) {
        const b = fills[seen[j]];
        const dr = ((b >> 16) & 0xff) - ar;
        const dg = ((b >> 8) & 0xff) - ag;
        const db = (b & 0xff) - ab;
        const len2 = dr * dr + dg * dg + db * db;
        if (!len2) continue;
        const t = ((or - ar) * dr + (og - ag) * dg + (ob - ab) * db) / len2;
        if (t < 0 || t > 1) continue;
        const residual2 =
          (or - ar - t * dr) ** 2 + (og - ag - t * dg) ** 2 + (ob - ab - t * db) ** 2;
        if (residual2 >= bestResidual2) continue;
        // The pixel's own fill partway between the two is a gradient
        // band. One next to an end is a blend shade the palette picked up.
        const u = ((cr - ar) * dr + (cg - ag) * dg + (cb - ab) * db) / len2;
        if (
          u >= BLEND_BAND_END &&
          u <= 1 - BLEND_BAND_END &&
          (cr - ar - u * dr) ** 2 + (cg - ag - u * dg) ** 2 + (cb - ab - u * db) ** 2 < tolerance2
        ) {
          continue;
        }
        bestResidual2 = residual2;
        pick = t < 0.5 ? seen[m] : seen[j];
      }
    }
    if (pick === own) continue;
    const color = palette[pick];
    data[i] = (color >> 16) & 0xff;
    data[i + 1] = (color >> 8) & 0xff;
    data[i + 2] = color & 0xff;
  }
  return img;
}

// despeckleColors: a thin region is kept as a line when this share of
// its boundary touches one color; a thin region whose color lies within
// SLIVER_DISTANCE (RGB) of the segment between its two main neighbors is
// a blend sliver left by color reduction.
const LINE_SIDE_SHARE = 0.8;
const SLIVER_DISTANCE = 40;

/**
 * Speck removal on a color-reduced image, in place of the tracer's own
 * filter. The tracer drops every region smaller than `size` x `size`
 * pixels and also every region whose perimeter reaches its area: each
 * line 2 px wide or thinner, however long. Here a small region merges
 * into the color it borders most (or turns transparent when that is
 * transparency), and a thin region goes only when it is a blend sliver
 * between two colors; lines on one color and outlines between two fills
 * stay. Repeats until nothing changes (at most 4 passes), since merged
 * specks can leave new ones. 4-connected, exact colors. Mutates img.
 * @param {ImageData} img
 * @param {number} size
 */
export function despeckleColors(img, size) {
  const minArea = size * size;
  if (minArea <= 1) return img;
  const { data, width, height } = img;
  const n = width * height;
  const keys = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    keys[p] =
      data[i + 3] < ALPHA_THRESHOLD ? -1 : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  }
  const label = new Int32Array(n);
  const queue = new Int32Array(n);
  const neighbors = [0, 0, 0, 0];
  const around = new Map();
  for (let pass = 0; pass < 4; pass++) {
    label.fill(-1);
    /** @type {{ start: number, count: number, thin: boolean }[]} */
    const candidates = [];
    let next = 0;
    let end = 0;
    for (let s = 0; s < n; s++) {
      if (label[s] !== -1) continue;
      const key = keys[s];
      const start = end;
      label[s] = next;
      queue[end++] = s;
      let perimeter = 0;
      for (let head = start; head < end; head++) {
        const p = queue[head];
        const x = p % width;
        let k = 0;
        if (x > 0) neighbors[k++] = p - 1;
        if (x < width - 1) neighbors[k++] = p + 1;
        if (p >= width) neighbors[k++] = p - width;
        if (p + width < n) neighbors[k++] = p + width;
        for (let j = 0; j < k; j++) {
          const q = neighbors[j];
          if (keys[q] !== key) {
            perimeter += 1;
          } else if (label[q] === -1) {
            label[q] = next;
            queue[end++] = q;
          }
        }
      }
      const count = end - start;
      if (key !== -1 && (count < minArea || perimeter >= count)) {
        candidates.push({ start, count, thin: count >= minArea });
      }
      next += 1;
    }
    candidates.sort((a, b) => a.count - b.count);
    let changed = false;
    for (const { start, count, thin } of candidates) {
      const own = keys[queue[start]];
      around.clear();
      let total = 0;
      for (let m = start; m < start + count; m++) {
        const p = queue[m];
        const x = p % width;
        let k = 0;
        if (x > 0) neighbors[k++] = p - 1;
        if (x < width - 1) neighbors[k++] = p + 1;
        if (p >= width) neighbors[k++] = p - width;
        if (p + width < n) neighbors[k++] = p + width;
        for (let j = 0; j < k; j++) {
          const other = keys[neighbors[j]];
          if (other === own) continue;
          around.set(other, (around.get(other) || 0) + 1);
          total += 1;
        }
      }
      if (!total) continue;
      let fill = own;
      let best = 0;
      let second = own;
      let secondBest = 0;
      for (const [other, c] of around) {
        if (c > best) {
          second = fill;
          secondBest = best;
          fill = other;
          best = c;
        } else if (c > secondBest) {
          second = other;
          secondBest = c;
        }
      }
      if (thin) {
        if (best >= total * LINE_SIDE_SHARE) continue; // a line on one color
        if (fill === -1 || second === -1 || secondBest === 0) continue;
        if (!betweenColors(own, fill, second)) continue; // an outline
      }
      changed = true;
      for (let m = start; m < start + count; m++) keys[queue[m]] = fill;
    }
    if (!changed) break;
  }
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const key = keys[p];
    if (key === -1) {
      data[i + 3] = 0;
      continue;
    }
    data[i] = (key >> 16) & 0xff;
    data[i + 1] = (key >> 8) & 0xff;
    data[i + 2] = key & 0xff;
  }
  return img;
}

/**
 * Whether color `c` lies near the RGB segment from `a` to `b` (blend).
 * @param {number} c packed 0xRRGGBB
 * @param {number} a packed 0xRRGGBB
 * @param {number} b packed 0xRRGGBB
 */
function betweenColors(c, a, b) {
  /**
   * @param {number} key
   */
  const rgb = (key) => [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
  const [cr, cg, cb] = rgb(c);
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const dr = br - ar;
  const dg = bg - ag;
  const db = bb - ab;
  const len2 = dr * dr + dg * dg + db * db;
  if (!len2) return false;
  const t = ((cr - ar) * dr + (cg - ag) * dg + (cb - ab) * db) / len2;
  if (t <= 0 || t >= 1) return false;
  return Math.hypot(cr - (ar + t * dr), cg - (ag + t * dg), cb - (ab + t * db)) < SLIVER_DISTANCE;
}

/**
 * Matte choke: peel `passes` one-pixel rings off the opaque region,
 * clearing the alpha of opaque pixels 4-adjacent to transparency. Eats
 * the background-blend fringe left along subject boundaries after a
 * knockout, whatever color the fringe is; thin features shrink by the
 * same amount, so the amount is user-controlled. Mutates img in place.
 * @param {ImageData} img
 * @param {number} passes
 */
export function erodeAlpha(img, passes) {
  const { data, width, height } = img;
  for (let pass = 0; pass < passes; pass++) {
    const peel = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (data[p * 4 + 3] < ALPHA_THRESHOLD) continue;
        if (
          (x > 0 && data[(p - 1) * 4 + 3] < ALPHA_THRESHOLD) ||
          (x < width - 1 && data[(p + 1) * 4 + 3] < ALPHA_THRESHOLD) ||
          (y > 0 && data[(p - width) * 4 + 3] < ALPHA_THRESHOLD) ||
          (y < height - 1 && data[(p + width) * 4 + 3] < ALPHA_THRESHOLD)
        ) {
          peel.push(p);
        }
      }
    }
    if (peel.length === 0) break;
    for (const p of peel) data[p * 4 + 3] = 0;
  }
  return img;
}

/**
 * Two passes of a separable running-sum box blur with a (2r+1) window,
 * in place. Values past the edges repeat the nearest edge value.
 * @param {Float32Array} values
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 */
function boxBlur(values, width, height, radius) {
  const window = 2 * radius + 1;
  // One line at a time, padded by `radius` repeats of each end so the
  // running sum needs no bounds checks (slow in WebKit).
  const line = new Float32Array(width + 2 * radius + 1);
  /**
   * @param {number} length
   * @param {number} count
   * @param {number} stride
   * @param {number} step
   */
  const blur = (length, count, stride, step) => {
    for (let l = 0; l < count; l++) {
      const base = l * stride;
      const first = values[base];
      const last = values[base + (length - 1) * step];
      for (let k = 0; k < radius; k++) line[k] = first;
      for (let i = 0; i < length; i++) line[radius + i] = values[base + i * step];
      for (let k = radius + length; k <= length + 2 * radius; k++) line[k] = last;
      let sum = 0;
      for (let k = 0; k <= 2 * radius; k++) sum += line[k];
      for (let i = 0; i < length; i++) {
        values[base + i * step] = sum / window;
        sum += line[i + 2 * radius + 1] - line[i];
      }
    }
  };
  // Columns run a row at a time over a snapshot: walking a column one
  // stride apart misses the cache on every read.
  const source = new Float32Array(values.length);
  const sums = new Float64Array(width);
  /**
   * @param {number} y
   */
  const row = (y) => Math.min(height - 1, Math.max(0, y)) * width;
  const blurColumns = () => {
    source.set(values);
    sums.fill(0);
    for (let k = -radius; k <= radius; k++) {
      const r = row(k);
      for (let x = 0; x < width; x++) sums[x] += source[r + x];
    }
    for (let y = 0; y < height; y++) {
      const out = y * width;
      const add = row(y + radius + 1);
      const drop = row(y - radius);
      for (let x = 0; x < width; x++) {
        values[out + x] = sums[x] / window;
        sums[x] += source[add + x] - source[drop + x];
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    blur(width, height, width, 1);
    blurColumns();
  }
}

/**
 * Matte smoothing: box-blur the opaque mask twice with a (2r+1) window and
 * threshold it at half, so bumps and notches narrower than about `radius`
 * flatten while straight edges stay put; corners round by about `radius`
 * and features thinner than it vanish. Pixels outside the image count as
 * their nearest edge pixel, so the canvas border is not eaten. Newly
 * opaque pixels take the color of an adjacent opaque pixel. Mutates img.
 * @param {ImageData} img
 * @param {number} radius
 */
export function smoothAlpha(img, radius) {
  if (radius <= 0) return img;
  const { data, width, height } = img;
  const n = width * height;
  const mask = new Float32Array(n);
  for (let p = 0; p < n; p++) mask[p] = data[p * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  boxBlur(mask, width, height, radius);

  /** @type {number[]} newly opaque pixels still waiting for a color */
  let pending = [];
  for (let p = 0; p < n; p++) {
    const was = data[p * 4 + 3] >= ALPHA_THRESHOLD;
    const now = mask[p] >= 0.5;
    if (was && !now) data[p * 4 + 3] = 0;
    else if (!was && now) pending.push(p);
  }
  const colored = new Uint8Array(n);
  for (let p = 0; p < n; p++) colored[p] = data[p * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  // Grow colors ring by ring into the filled-in pixels.
  while (pending.length) {
    const next = [];
    const filled = [];
    for (const p of pending) {
      const x = p % width;
      const neighbours = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        p >= width ? p - width : -1,
        p < n - width ? p + width : -1,
      ];
      const source = neighbours.find((q) => q >= 0 && colored[q]);
      if (source === undefined) next.push(p);
      else filled.push([p, source]);
    }
    if (!filled.length) break;
    for (const [p, q] of filled) {
      data.copyWithin(p * 4, q * 4, q * 4 + 3);
      data[p * 4 + 3] = 255;
      colored[p] = 1;
    }
    pending = next;
  }
  return img;
}

/**
 * Distance in pixels from each set bit of a mask to the nearest unset bit
 * or the mask's edge (chamfer 3-4, so diagonals cost about √2). Unset
 * bits are 0.
 * @param {Uint8Array} bits
 * @param {number} width
 * @param {number} height
 */
function maskDepth(bits, width, height) {
  const far = 3 * (width + height);
  const depth = new Int32Array(width * height);
  for (let p = 0; p < depth.length; p++) depth[p] = bits[p] ? far : 0;
  /**
   * @param {number} x
   * @param {number} y
   */
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : depth[y * width + x]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!depth[p]) continue;
      depth[p] = Math.min(
        depth[p],
        at(x - 1, y) + 3,
        at(x, y - 1) + 3,
        at(x - 1, y - 1) + 4,
        at(x + 1, y - 1) + 4,
      );
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const p = y * width + x;
      if (!depth[p]) continue;
      depth[p] = Math.min(
        depth[p],
        at(x + 1, y) + 3,
        at(x, y + 1) + 3,
        at(x + 1, y + 1) + 4,
        at(x - 1, y + 1) + 4,
      );
    }
  }
  return Float32Array.from(depth, (d) => d / 3);
}

// smoothLabels: colors that take part in a stroke's vote, most common
// first. Reduced images have a handful; an unreduced photo has thousands,
// and its rare shades would only add cost.
const SMOOTH_COLORS = 16;
const SMOOTH_PASSES = 3;

/**
 * Smooth brush: inside each stroke, every pixel takes the color that most
 * of its surroundings have, so bumps, notches and stair steps narrower
 * than about `radius` flatten while longer edges stay put. Each color's
 * mask is box-blurred twice (as smoothAlpha does for the matte) over the
 * stroke's box grown by the blur's reach, the strongest color wins, and
 * the vote repeats `passes` times.
 * Transparency counts as a color, so erased edges smooth too, and no new
 * colors appear. `regions` hold a stroke's mask in image pixels: { x, y,
 * width, height, bits (1 inside), radius }. Mutates img in place.
 * @param {{ x: number, y: number, width: number, height: number, bits: Uint8Array, radius: number }[]} regions
 * @param {ImageData} img
 */
export function smoothLabels(img, regions, passes = SMOOTH_PASSES) {
  const { data, width, height } = img;
  for (const region of regions) {
    const radius = Math.max(1, Math.round(region.radius));
    const reach = 2 * radius;
    const x0 = Math.max(0, region.x - reach);
    const y0 = Math.max(0, region.y - reach);
    const x1 = Math.min(width, region.x + region.width + reach);
    const y1 = Math.min(height, region.y + region.height + reach);
    const boxWidth = x1 - x0;
    const boxHeight = y1 - y0;
    if (boxWidth <= 0 || boxHeight <= 0) continue;
    const area = boxWidth * boxHeight;
    const depth = maskDepth(region.bits, region.width, region.height);
    const keys = new Int32Array(area);
    const best = new Float32Array(area);
    const winner = new Int32Array(area);
    const own = new Float32Array(area);
    const weight = new Float32Array(area);
    // One vote moves edges but keeps each color's area, so a notch only
    // spreads into a shallow dip; repeating it flattens the dip, as
    // curvature flow does.
    for (let pass = 0; pass < passes; pass++) {
      // Color key per box pixel; -1 is transparent.
      const counts = new Map();
      for (let y = 0; y < boxHeight; y++) {
        for (let x = 0; x < boxWidth; x++) {
          const i = ((y + y0) * width + x + x0) * 4;
          const key =
            data[i + 3] < ALPHA_THRESHOLD ? -1 : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
          keys[y * boxWidth + x] = key;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      const colors = [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, SMOOTH_COLORS)
        .map(([key]) => key);
      if (colors.length < 2) break;
      best.fill(-1);
      own.fill(0);
      for (const key of colors) {
        for (let p = 0; p < area; p++) weight[p] = keys[p] === key ? 1 : 0;
        boxBlur(weight, boxWidth, boxHeight, radius);
        for (let p = 0; p < area; p++) {
          if (keys[p] === key) own[p] = weight[p];
          if (weight[p] > best[p]) {
            best[p] = weight[p];
            winner[p] = key;
          }
        }
      }
      for (let y = 0; y < region.height; y++) {
        const by = y + region.y - y0;
        if (by < 0 || by >= boxHeight) continue;
        for (let x = 0; x < region.width; x++) {
          const bx = x + region.x - x0;
          if (bx < 0 || bx >= boxWidth || !region.bits[y * region.width + x]) continue;
          const p = by * boxWidth + bx;
          const key = winner[p];
          if (key === keys[p]) continue;
          // Fade in from the stroke's edge, so the edges it moves meet
          // the untouched ones outside without a step.
          const strength = Math.min(1, depth[y * region.width + x] / radius);
          if (strength * best[p] <= strength * own[p] + (1 - strength)) continue;
          const i = ((by + y0) * width + bx + x0) * 4;
          if (key === -1) {
            data[i + 3] = 0;
          } else {
            data[i] = (key >> 16) & 0xff;
            data[i + 1] = (key >> 8) & 0xff;
            data[i + 2] = key & 0xff;
            data[i + 3] = 255;
          }
        }
      }
    }
  }
  return img;
}

/**
 * Smooth outlines: one smoothLabels vote over the whole image at `radius`
 * (trace pixels), clearing the pixel-level steps and noise reduced flat
 * art leaves along its edges. One pass keeps lines a few pixels wide that
 * repeated votes would thin. Mutates img in place.
 * @param {ImageData} img
 * @param {number} radius
 */
export function smoothOutlines(img, radius) {
  if (radius <= 0) return img;
  const { width, height } = img;
  const bits = new Uint8Array(width * height).fill(1);
  return smoothLabels(img, [{ x: 0, y: 0, width, height, bits, radius }], 1);
}

/**
 * Matte defringe: recolor the outermost `depth` rings of the opaque
 * region from the colors one ring deeper, hiding background-blend fringe
 * without shrinking the shape. Complements erodeAlpha: trim deletes
 * boundary pixels (thin features shrink), defringe repaints them. Rings
 * are processed from the innermost fringe ring outward so interior colors
 * propagate to the edge; pixels with no deeper neighbor (features thinner
 * than 2*depth) keep their original color. With `keepPalette` a fringe
 * pixel takes the most common deeper color instead of their average, so a
 * color-reduced image gains no new colors. Mutates img in place.
 * @param {ImageData} img
 * @param {number} depth
 * @param {{ keepPalette?: boolean }} [options]
 */
export function defringeAlpha(img, depth, { keepPalette = false } = {}) {
  if (depth <= 0) return img;
  const { data, width, height } = img;
  const n = width * height;
  // BFS distance from transparency: 0 transparent, d for the d-th opaque
  // ring, -1 for opaque pixels deeper than `depth` (clean interior).
  const dist = new Int32Array(n).fill(-1);
  let queue = [];
  for (let p = 0; p < n; p++) {
    if (data[p * 4 + 3] < ALPHA_THRESHOLD) {
      dist[p] = 0;
      queue.push(p);
    }
  }
  if (queue.length === 0 || queue.length === n) return img;
  /**
   * @type {number[][]}
   */
  const rings = [];
  for (let d = 1; d <= depth && queue.length; d++) {
    /**
     * @type {number[]}
     */
    const next = [];
    for (const p of queue) {
      const x = p % width;
      const y = (p / width) | 0;
      /**
       * @param {number} q
       */
      const grow = (q) => {
        if (dist[q] === -1) {
          dist[q] = d;
          next.push(q);
        }
      };
      if (x > 0) grow(p - 1);
      if (x < width - 1) grow(p + 1);
      if (y > 0) grow(p - width);
      if (y < height - 1) grow(p + width);
    }
    rings.push(next);
    queue = next;
  }

  for (let d = rings.length; d >= 1; d--) {
    for (const p of rings[d - 1]) {
      const x = p % width;
      const y = (p / width) | 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      /** @type {Map<number, number>} deeper colors by vote, for keepPalette */
      const votes = new Map();
      let winner = -1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          // Pull only from deeper rings (already repainted) or interior.
          if (q === p || (dist[q] !== -1 && dist[q] <= d)) continue;
          const j = q * 4;
          r += data[j];
          g += data[j + 1];
          b += data[j + 2];
          count += 1;
          if (keepPalette) {
            const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
            const tally = (votes.get(key) ?? 0) + 1;
            votes.set(key, tally);
            if (winner < 0 || tally > (votes.get(winner) ?? 0)) winner = key;
          }
        }
      }
      if (count > 0) {
        const j = p * 4;
        if (keepPalette) {
          data[j] = (winner >> 16) & 0xff;
          data[j + 1] = (winner >> 8) & 0xff;
          data[j + 2] = winner & 0xff;
        } else {
          data[j] = r / count;
          data[j + 1] = g / count;
          data[j + 2] = b / count;
        }
      }
    }
  }
  return img;
}

/**
 * Threshold alpha to 0 or 255 so anti-aliased edge fringe cannot fragment
 * the trace into junk paths. Mutates img in place.
 * @param {ImageData} img
 */
export function binarizeAlpha(img) {
  const { data } = img;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] >= ALPHA_THRESHOLD ? 255 : 0;
  }
  return img;
}

/**
 * Luminance (Rec. 601) grayscale conversion, alpha preserved. In place.
 * @param {ImageData} img
 */
export function toGrayscale(img) {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = l;
  }
  return img;
}

/**
 * Most common opaque color, sampled with a stride for speed.
 * @param {ImageData} img
 */
export function dominantOpaqueColor(img) {
  const { data } = img;
  const pixelCount = data.length / 4;
  const stride = Math.max(1, Math.floor(pixelCount / 4096)) * 4;
  const counts = new Map();
  /** @type {number | null} */
  let best = null;
  let bestCount = 0;
  for (let i = 0; i < data.length; i += stride) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      best = key;
    }
  }

  if (best === null) return [255, 255, 255];
  return [(best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff];
}

/**
 * Convert an RGB color with the same luma calculation as toGrayscale.
 * @param {[number, number, number]} color
 * @returns {[number, number, number]}
 */
export function toGrayscaleColor([r, g, b]) {
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return [gray, gray, gray];
}

// Solid color thresholds for analyzeFlatness. The two shares are of all
// opaque samples; the interior share is of the color's own samples.
// Measured on anti-aliased flat art: real colors have 29% or more interior
// pixels (thin lines included), edge blends 6% or fewer.
const SOLID_MIN_SHARE = 0.001;
const SOLID_LINE_SHARE = 0.01;
const SOLID_MIN_INTERIOR = 0.2;
// Exact solid colors must cover this share of samples to be trusted;
// below it (JPEG, resampling, noise) similarFlatness clusters instead.
// Clean flat PNGs measure 0.979 or more, compressed or resampled 0.967 or less.
const EXACT_SOLID_SHARE = 0.975;
// similarFlatness: least neighbor tolerance (sum of RGB differences),
// least share of samples inside areas, Oklab cluster radius, widest mean
// cluster spread (gradients measure 0.0085, compressed flat art 0.0054 or
// less), and the share that makes a color a thin line.
const SIMILAR_MIN_TOLERANCE = 24;
const SIMILAR_MIN_INSIDE = 0.5;
const SIMILAR_CLUSTER_DISTANCE = 0.03;
const SIMILAR_MAX_SPREAD = 0.007;
const SIMILAR_LINE_SHARE = 0.02;

/**
 * Coverage-based flatness heuristic. Flat-color sources (logos, text,
 * screenshots, pixel art) concentrate almost all pixels in a handful of
 * colors even when anti-aliasing adds thousands of rare fringe colors, so
 * coverage is tested before unique counts: flat when the 16 most common
 * sampled colors cover >= 90% of opaque samples. Exact sampled images below
 * 256 colors are also flat, and noisy flat art can still pass when its
 * colors collapse into a few dominant RGB clusters. Clustered art starts with
 * a less aggressive color budget so distressed details survive.
 * Transparent pixels are ignored; a fully
 * transparent image is not flat.
 *
 * Flat results also list `solids`, the colors of the artwork as [r, g, b]:
 * every color with at least SOLID_MIN_SHARE of the samples that either
 * fills areas (some samples have all four neighbors the same color) or is
 * common enough to be a thin line. Anti-alias blends sit only on edges,
 * so they rarely have interior pixels. colorCount counts the solids, so
 * small accents past 95% coverage still get a palette slot.
 * @param {ImageData} img
 */
export function analyzeFlatness(img) {
  const { solidShare, ...exact } = exactFlatness(img);
  if (exact.solids && (solidShare ?? 0) >= EXACT_SOLID_SHARE) return exact;
  return similarFlatness(img) ?? exact;
}

// withoutBlendShades: how close (RGB) a color must sit to the segment
// between two fills to count as their mix, and how far along it (share
// of the way from either end) it must be.
const SHADE_TOLERANCE = 24;
const SHADE_END = 0.08;
// A real color fills areas: this share of its pixels have neighbors all
// within the image's noise of their own color. Blur shades change from
// pixel to pixel across an edge, and anti-alias shades are lines a pixel
// or two wide. Measured: blur and anti-alias shades 0.04 or less, while
// textured real colors in large AI art (hair, gun-metal greys) measure
// 0.08 to 0.19 and must keep their own color.
const SHADE_MIN_INTERIOR = 0.05;
// A halftone or textured area (dotted hair, screened shading) fails the
// interior test too, but covers an area of its own: a shade is also only
// dropped when this share of its pixels have both of its ends within
// SHADE_REACH pixels, as a soft edge's band between two fills does.
const SHADE_MIN_BETWEEN = 0.6;
const SHADE_REACH = 12;

/**
 * Detected colors without the shades a soft edge leaves between two
 * fills. Blurred or resampled flat art grows bands of every mix of the
 * two colors along each edge, and the common ones pass for colors. A
 * color that is a mix of two other detected colors is dropped when its
 * pixels rarely fill areas and mostly lie where those two colors meet. `solids` are ordered most common first; the
 * least common are tested first and only kept colors serve as ends.
 * @param {ImageData} img
 * @param {number[][]} solids
 */
function withoutBlendShades(img, solids) {
  if (solids.length < 3) return solids;
  const { data, width } = img;
  const pixelCount = data.length / 4;
  const height = pixelCount / width;
  let stride = Math.max(1, Math.ceil(pixelCount / 200_000));
  if (stride % 2 === 0) stride += 1;
  const row = width * 4;
  /**
   * @param {number} i
   * @param {number} j
   */
  const step = (i, j) =>
    Math.abs(data[i] - data[j]) +
    Math.abs(data[i + 1] - data[j + 1]) +
    Math.abs(data[i + 2] - data[j + 2]);
  // Noise level as similarFlatness measures it, for the interior test.
  const steps = [];
  for (let p = 0; p < pixelCount; p += stride * 7) {
    if (p % width < width - 1 && data[p * 4 + 3] >= ALPHA_THRESHOLD) {
      steps.push(step(p * 4, p * 4 + 4));
    }
  }
  steps.sort((a, b) => a - b);
  const flatStep = Math.max(6, 2 * (steps[steps.length >> 1] ?? 0));
  const tolerance2 = SHADE_TOLERANCE * SHADE_TOLERANCE;
  /**
   * @param {number[]} c
   * @param {number[]} a
   * @param {number[]} b
   */
  const along = (c, a, b) => {
    const dr = b[0] - a[0];
    const dg = b[1] - a[1];
    const db = b[2] - a[2];
    const len2 = dr * dr + dg * dg + db * db;
    if (!len2) return null;
    const t = ((c[0] - a[0]) * dr + (c[1] - a[1]) * dg + (c[2] - a[2]) * db) / len2;
    const residual2 =
      (c[0] - a[0] - t * dr) ** 2 + (c[1] - a[1] - t * dg) ** 2 + (c[2] - a[2] - t * db) ** 2;
    return { t, residual2 };
  };
  /**
   * @param {number} i
   * @param {number[][]} colors
   */
  const nearest = (i, colors) => {
    let best = -1;
    let bestDistance = Infinity;
    for (let k = 0; k < colors.length; k++) {
      const c = colors[k];
      const d = (data[i] - c[0]) ** 2 + (data[i + 1] - c[1]) ** 2 + (data[i + 2] - c[2]) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = k;
      }
    }
    return best;
  };
  // Share of the color's pixels whose four neighbors match their own.
  /**
   * @param {number[][]} colors
   * @param {number} k
   */
  const measure = (colors, k) => {
    let count = 0;
    let interior = 0;
    for (let p = 0; p < pixelCount; p += stride) {
      const i = p * 4;
      if (data[i + 3] < ALPHA_THRESHOLD || nearest(i, colors) !== k) continue;
      count += 1;
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      if (
        step(i, i - 4) <= flatStep &&
        step(i, i + 4) <= flatStep &&
        step(i, i - row) <= flatStep &&
        step(i, i + row) <= flatStep
      ) {
        interior += 1;
      }
    }
    return count ? interior / count : 0;
  };
  // Share of the color's pixels with both `a` and `b` within SHADE_REACH:
  // a soft edge's shade lies in the band where they meet.
  /**
   * @param {number[][]} colors
   * @param {number} k
   * @param {number} a
   * @param {number} b
   */
  const between = (colors, k, a, b) => {
    let count = 0;
    let found = 0;
    for (let p = 0; p < pixelCount; p += stride * 3) {
      const i = p * 4;
      if (data[i + 3] < ALPHA_THRESHOLD || nearest(i, colors) !== k) continue;
      count += 1;
      const x0 = p % width;
      const y0 = (p - x0) / width;
      let seenA = false;
      let seenB = false;
      for (
        let y = Math.max(0, y0 - SHADE_REACH);
        y <= Math.min(height - 1, y0 + SHADE_REACH);
        y++
      ) {
        for (
          let x = Math.max(0, x0 - SHADE_REACH);
          x <= Math.min(width - 1, x0 + SHADE_REACH);
          x++
        ) {
          const j = (y * width + x) * 4;
          if (data[j + 3] < ALPHA_THRESHOLD) continue;
          const near = nearest(j, colors);
          if (near === a) seenA = true;
          else if (near === b) seenB = true;
        }
        if (seenA && seenB) break;
      }
      if (seenA && seenB) found += 1;
    }
    return count ? found / count : 0;
  };
  const kept = [...solids];
  for (let k = kept.length - 1; k >= 2; k--) {
    const color = kept[k];
    const ends = kept.filter((_, j) => j !== k);
    let shade = false;
    for (let m = 0; m < ends.length && !shade; m++) {
      for (let j = m + 1; j < ends.length && !shade; j++) {
        const fit = along(color, ends[m], ends[j]);
        if (!fit || fit.residual2 > tolerance2) continue;
        if (fit.t < SHADE_END || fit.t > 1 - SHADE_END) continue;
        shade =
          measure(kept, k) < SHADE_MIN_INTERIOR &&
          between(kept, k, kept.indexOf(ends[m]), kept.indexOf(ends[j])) >= SHADE_MIN_BETWEEN;
        if (/** @type {any} */ (globalThis).SHADE_DEBUG)
          console.log(
            "CAND",
            JSON.stringify(color),
            "interior",
            measure(kept, k).toFixed(2),
            "between",
            between(kept, k, kept.indexOf(ends[m]), kept.indexOf(ends[j])).toFixed(2),
          );
      }
    }
    if (shade) kept.splice(k, 1);
  }
  return kept;
}

/**
 * Solid colors of flat art whose colors are not exact: JPEG compression,
 * resampling or light noise spread each flat color over many near
 * shades. A sample is inside an area when its four neighbors are within
 * a tolerance that follows the image's own noise level (anti-alias
 * blends sit between colors that differ sharply, so they drop out), and
 * those samples are grouped into perceptual (Oklab) clusters. Returns
 * null when the clusters do not describe flat art: too many, too wide
 * (smooth gradients), or too little of the image inside areas (photos).
 * @param {ImageData} img
 */
function similarFlatness(img) {
  const { data, width } = img;
  const pixelCount = data.length / 4;
  const height = pixelCount / width;
  let stride = Math.max(1, Math.ceil(pixelCount / 200_000));
  if (stride % 2 === 0) stride += 1;
  /**
   * @param {number} i
   * @param {number} j
   */
  const distance = (i, j) =>
    Math.abs(data[i] - data[j]) +
    Math.abs(data[i + 1] - data[j + 1]) +
    Math.abs(data[i + 2] - data[j + 2]);
  // Noise level: the median difference to the right-hand neighbor, which
  // flat areas dominate in flat art.
  const steps = [];
  for (let p = 0; p < pixelCount; p += stride * 7) {
    if (p % width < width - 1) steps.push(distance(p * 4, p * 4 + 4));
  }
  steps.sort((a, b) => a - b);
  const tolerance = Math.max(SIMILAR_MIN_TOLERANCE, 3 * (steps[steps.length >> 1] ?? 0));

  // 5-bit bins hold running sums so each cluster gets its mean color.
  /**
   * @param {Map<number, number[]>} bins
   * @param {number} i
   */
  const bin = (bins, i) => {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    let entry = bins.get(key);
    if (!entry) bins.set(key, (entry = [0, 0, 0, 0]));
    entry[0] += data[i];
    entry[1] += data[i + 1];
    entry[2] += data[i + 2];
    entry[3] += 1;
  };
  const inside = new Map();
  const everywhere = new Map();
  const row = width * 4;
  let opaque = 0;
  let insideCount = 0;
  for (let p = 0; p < pixelCount; p += stride) {
    const i = p * 4;
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    opaque += 1;
    bin(everywhere, i);
    const x = p % width;
    const y = (p - x) / width;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
    if (
      distance(i, i - 4) > tolerance ||
      distance(i, i + 4) > tolerance ||
      distance(i, i - row) > tolerance ||
      distance(i, i + row) > tolerance
    ) {
      continue;
    }
    insideCount += 1;
    bin(inside, i);
  }
  if (opaque === 0 || insideCount < opaque * SIMILAR_MIN_INSIDE) return null;

  // Greedy by frequency: a bin joins the nearest cluster seed within
  // SIMILAR_CLUSTER_DISTANCE, else seeds a cluster of its own.
  /**
   * @param {Map<number, number[]>} bins
   */
  const cluster = (bins) => {
    const clusters = [];
    for (const [r, g, b, count] of [...bins.values()].sort((x, y) => y[3] - x[3])) {
      const lab = srgbToOklab([
        Math.round(r / count),
        Math.round(g / count),
        Math.round(b / count),
      ]);
      /** @type {{ lab: number[], sum: number[], count: number, spread: number } | null} */
      let best = null;
      let bestDistance = SIMILAR_CLUSTER_DISTANCE;
      for (const c of clusters) {
        const d = Math.hypot(c.lab[0] - lab[0], c.lab[1] - lab[1], c.lab[2] - lab[2]);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      if (best) {
        best.sum[0] += r;
        best.sum[1] += g;
        best.sum[2] += b;
        best.count += count;
        best.spread += bestDistance * count;
      } else {
        clusters.push({ lab, sum: [r, g, b], count, spread: 0 });
      }
    }
    return clusters;
  };
  const areas = cluster(inside);
  const solidClusters = areas.filter((c) => c.count >= opaque * SOLID_MIN_SHARE);
  const covered = solidClusters.reduce((sum, c) => sum + c.count, 0);
  const spread = areas.reduce((sum, c) => sum + c.spread, 0) / insideCount;
  if (covered < insideCount * 0.9 || spread >= SIMILAR_MAX_SPREAD) return null;
  // Thin lines have no inside samples: a common color anywhere that is
  // not near an area color still counts.
  /**
   * @param {{ lab: number[] }} a
   * @param {{ lab: number[] }} b
   */
  const near = (a, b) =>
    Math.hypot(a.lab[0] - b.lab[0], a.lab[1] - b.lab[1], a.lab[2] - b.lab[2]) <
    SIMILAR_CLUSTER_DISTANCE;
  for (const c of cluster(everywhere)) {
    if (c.count >= opaque * SIMILAR_LINE_SHARE && !solidClusters.some((s) => near(s, c))) {
      solidClusters.push(c);
    }
  }
  // A small area far from every other color is an accent, not a shade.
  for (const c of areas) {
    if (
      c.count < opaque * SOLID_MIN_SHARE &&
      c.count >= opaque * SOLID_MIN_SHARE * FLAT_ACCENT_SHARE &&
      solidClusters.every(
        (s) =>
          Math.hypot(s.lab[0] - c.lab[0], s.lab[1] - c.lab[1], s.lab[2] - c.lab[2]) >=
          FLAT_ACCENT_DISTANCE,
      )
    ) {
      solidClusters.push(c);
    }
  }
  if (solidClusters.length > 32) return null;
  const solids = withoutBlendShades(
    img,
    solidClusters
      .sort((a, b) => b.count - a.count)
      .map((c) => c.sum.map((v) => Math.round(v / c.count))),
  );
  return { flat: true, colorCount: Math.max(2, solids.length), solids };
}

/**
 * analyzeFlatness on exact colors (described above), plus `solidShare`:
 * the share of samples whose exact color is one of the solids.
 * @param {ImageData} img
 */
function exactFlatness(img) {
  const { data, width } = img;
  const pixelCount = data.length / 4;
  const height = pixelCount / width;
  /**
   * @param {number} i
   */
  const keyAt = (i) => (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  // Odd pixel stride so sampling does not lock to even image widths and
  // hit the same columns every row.
  let stride = Math.max(1, Math.ceil(pixelCount / 200_000));
  if (stride % 2 === 0) stride += 1;
  const counts = new Map();
  const interior = new Map();
  let total = 0;
  for (let p = 0; p < pixelCount; p += stride) {
    const i = p * 4;
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key = keyAt(i);
    counts.set(key, (counts.get(key) || 0) + 1);
    total += 1;
    const x = p % width;
    const y = (p - x) / width;
    if (
      x > 0 &&
      x < width - 1 &&
      y > 0 &&
      y < height - 1 &&
      keyAt(i - 4) === key &&
      keyAt(i + 4) === key &&
      keyAt(i - width * 4) === key &&
      keyAt(i + width * 4) === key
    ) {
      interior.set(key, (interior.get(key) || 0) + 1);
    }
  }
  if (total === 0) return { flat: false, colorCount: 256 };
  const sorted = [...counts.values()].sort((a, b) => b - a);
  let covered = 0;
  let topCoverage = 0;
  let colorCount = sorted.length;
  let counted = false;
  for (let i = 0; i < sorted.length; i++) {
    covered += sorted[i];
    if (i < 16) topCoverage = covered / total;
    if (!counted && covered / total >= 0.95) {
      colorCount = i + 1;
      counted = true;
    }
    if (counted && i >= 16) break;
  }
  /**
   * @param {number} key
   */
  const toRgb = (key) => [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
  if (counts.size <= 32 && topCoverage < 0.9) {
    return {
      flat: true,
      colorCount: Math.max(2, counts.size),
      solids: [...counts.keys()].map(toRgb),
      solidShare: 1,
    };
  }
  if (topCoverage < 0.9) {
    const clusters = new Map();
    for (const [key, count] of counts) {
      const r = (key >> 16) & 0xff;
      const g = (key >> 8) & 0xff;
      const b = key & 0xff;
      const clusterKey = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
      clusters.set(clusterKey, (clusters.get(clusterKey) || 0) + count);
    }
    const clusterCounts = [...clusters.values()].sort((a, b) => b - a);
    let clusterCovered = 0;
    let clusterColorCount = clusterCounts.length;
    for (let i = 0; i < Math.min(8, clusterCounts.length); i++) {
      clusterCovered += clusterCounts[i];
      if (clusterCovered / total >= 0.95) {
        clusterColorCount = i + 1;
        break;
      }
    }
    if (clusterCovered / total >= 0.9 && clusterCounts[0] / total >= 0.35) {
      return { flat: true, colorCount: Math.min(32, Math.max(8, clusterColorCount * 2)) };
    }
  }
  if (topCoverage < 0.9) return { flat: false, colorCount: Math.min(32, Math.max(2, colorCount)) };
  const kept = [...counts]
    .filter(([key, count]) => {
      const share = count / total;
      if (share < SOLID_MIN_SHARE) return false;
      return share >= SOLID_LINE_SHARE || (interior.get(key) || 0) / count >= SOLID_MIN_INTERIOR;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 32);
  const solidShare = kept.reduce((sum, [, count]) => sum + count, 0) / total;
  const solids = withoutBlendShades(
    img,
    kept.map(([key]) => toRgb(key)),
  );
  return { flat: true, colorCount: Math.max(2, solids.length), solids, solidShare };
}

/**
 * Snap every opaque pixel to the nearest of `swatches` ("#RRGGBB") in
 * Oklab: a fixed palette (brand colors, stocked inks) in place of
 * quantize's automatic one. Transparent pixels get the dominant opaque
 * color's swatch, as quantize backfills them. Mutates img in place.
 * @param {ImageData} img
 * @param {string[]} swatches
 */
export function mapToPalette(img, swatches) {
  const palette = swatches.map((hex) => {
    const rgb = /** @type {[number, number, number]} */ (parseHexColor(hex));
    return { rgb, lab: srgbToOklab(rgb) };
  });
  /** @type {Map<number, [number, number, number]>} */
  const nearest = new Map();
  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  const snap = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let hit = nearest.get(key);
    if (!hit) {
      const [L, A, B] = srgbToOklab([r, g, b]);
      let best = Infinity;
      for (const { rgb, lab } of palette) {
        const d = (L - lab[0]) ** 2 + (A - lab[1]) ** 2 + (B - lab[2]) ** 2;
        if (d < best) {
          best = d;
          hit = rgb;
        }
      }
      // Callers pass at least one swatch, so the loop always picks one.
      nearest.set(key, /** @type {[number, number, number]} */ (hit));
    }
    return /** @type {[number, number, number]} */ (hit);
  };
  const { data } = img;
  const dominant = dominantOpaqueColor(img);
  const backfill = dominant ? snap(dominant[0], dominant[1], dominant[2]) : palette[0].rgb;
  for (let i = 0; i < data.length; i += 4) {
    const rgb = data[i + 3] < ALPHA_THRESHOLD ? backfill : snap(data[i], data[i + 1], data[i + 2]);
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  }
  return img;
}

// Quantize clusters colors at 6 bits per channel: a 4 MP photo carries
// around two million unique colors, which made median cut and k-means
// take tens of seconds. Bins 4 levels wide are invisible after reducing
// to at most 128 colors, and cap the work at 2^18 entries.
const QUANT_SHIFT = 2;
const QUANT_BITS = 8 - QUANT_SHIFT;
// Share of opaque pixels the most common colors must cover to seed quantize.
const FLAT_SEED_COVERAGE = 0.9;
// Oklab distance under which a common color is a near-duplicate seed: about
// one quantize bin, so resampling blends next to a solid color merge with it.
const FLAT_SEED_MIN_DISTANCE = 0.015;
// Least share of opaque pixels a flat color needs to take a palette slot.
const FLAT_SEED_MIN_SHARE = 0.001;
// Flat art seeding is for small palettes: auto-detect caps flat art at 32.
const FLAT_SEED_MAX_COLORS = 32;
// A flat color under FLAT_SEED_MIN_SHARE still takes a spare slot when it
// stands this far (Oklab) from every other color, as a small pink tongue
// does among browns and creams, and covers at least this share of that
// minimum. Highlights and shading sit closer to their own color.
const FLAT_ACCENT_DISTANCE = 0.1;
const FLAT_ACCENT_SHARE = 0.25;
// A distinct color under this share of the pixels counts as an accent when
// pixels are assigned (see accentReach2 in quantize).
const FLAT_ACCENT_MAX_SHARE = 0.005;
// Rare color groups tracked for accents, most common first.
const FLAT_ACCENT_CANDIDATES = 64;

/**
 * Median-cut color quantization to at most `colors` colors, refined with
 * k-means in Oklab. Flat art, where the `colors` most common colors cover
 * almost every pixel, keeps exactly those colors instead. Images that
 * already have at most `colors` exact colors are left untouched. A flat
 * color within `layerDiff` (the tracer's Merge) of a more common one gets
 * no slot, since the tracer would merge it away. `seeds` ([r, g, b], at
 * most `colors` used) replace that search when auto-detect already found
 * the art's colors, as compressed sources have no exact colors to seed
 * from. The palette comes from
 * opaque pixels only: hidden pixels carry garbage colors, and counting a
 * large knocked-out area as any one color would crowd small visible
 * details out of the palette. Transparent pixels are then painted with the dominant opaque
 * color's palette entry; alpha is untouched. `keep` ([r, g, b], painted
 * fill colors) join the palette exactly, on top of `colors`. Mutates img
 * in place and returns false when it remapped nothing, "flat" when the
 * palette is the art's own flat colors (seeded), otherwise "clustered".
 * @param {ImageData} img
 * @param {number} colors
 * @param {{ layerDiff?: number, seeds?: number[][] | null, keep?: number[][] | null }} [options]
 * @returns {false | "flat" | "clustered"}
 */
export function quantize(img, colors, { layerDiff = 0, seeds = null, keep = null } = {}) {
  const { data } = img;
  const kept = keep ?? [];
  const exact = new Set();
  for (let i = 0; i < data.length && exact.size <= colors + kept.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    exact.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  if (exact.size <= colors + kept.length) return false;
  const backfill = dominantOpaqueColor(img);

  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  const binOf = (r, g, b) =>
    ((r >> QUANT_SHIFT) << (2 * QUANT_BITS)) |
    ((g >> QUANT_SHIFT) << QUANT_BITS) |
    (b >> QUANT_SHIFT);
  const binCount = 1 << (3 * QUANT_BITS);
  const sumR = new Float64Array(binCount);
  const sumG = new Float64Array(binCount);
  const sumB = new Float64Array(binCount);
  const hits = new Uint32Array(binCount);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const bin = binOf(data[i], data[i + 1], data[i + 2]);
    sumR[bin] += data[i];
    sumG[bin] += data[i + 1];
    sumB[bin] += data[i + 2];
    hits[bin] += 1;
  }

  // One entry per occupied bin, at the bin's mean color. Clustering runs
  // in Oklab so splits and distances are perceptual: low color counts
  // keep visually distinct hues apart instead of merging them by raw RGB
  // proximity.
  let n = 0;
  for (let bin = 0; bin < binCount; bin++) if (hits[bin]) n += 1;
  const entryBin = new Int32Array(n);
  const count = new Float64Array(n);
  const lab = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const means = new Array(n);
  for (let bin = 0, e = 0; bin < binCount; bin++) {
    const h = hits[bin];
    if (!h) continue;
    means[e] = [Math.round(sumR[bin] / h), Math.round(sumG[bin] / h), Math.round(sumB[bin] / h)];
    const [L, A, B] = srgbToOklab(means[e]);
    entryBin[e] = bin;
    count[e] = h;
    lab[0][e] = L;
    lab[1][e] = A;
    lab[2][e] = B;
    e += 1;
  }

  // Median cut: repeatedly split the box with the largest channel range.
  // A box's widest channel is computed once, when the box is created.
  /**
   * @param {Int32Array} members
   */
  const makeBox = (members) => {
    let range = -1;
    let channel = 0;
    if (members.length >= 2) {
      for (let c = 0; c < 3; c++) {
        // Oklab, not RGB: a and b are signed and routinely negative, so RGB
        // sentinels leave max pinned at 0 and report an all-negative axis as
        // |min|, which wins splits it should lose.
        const values = lab[c];
        let min = Infinity;
        let max = -Infinity;
        for (const e of members) {
          if (values[e] < min) min = values[e];
          if (values[e] > max) max = values[e];
        }
        if (max - min > range) {
          range = max - min;
          channel = c;
        }
      }
    }
    return { members, range, channel };
  };
  const all = new Int32Array(n);
  for (let e = 0; e < n; e++) all[e] = e;
  // Flat art: when the most common colors already cover almost every
  // pixel, each gets its own one-color box and the splitting below stops
  // at once. Anti-alias blends stretch box ranges, so median cut would
  // split them off ahead of small solid accents. Near-duplicates of a
  // color already picked (resampling blends), and colors the tracer would
  // merge into it, count toward its coverage instead of taking a slot.
  // Rare colors take no slot either: when Max colors exceeds the art's
  // real colors, spare slots would go to edge blends and add fills.
  const opaqueCount = count.reduce((total, w) => total + w, 0);
  /**
   * @type {number[]}
   */
  const common = [];
  let commonCount = 0;
  const candidates = colors <= FLAT_SEED_MAX_COLORS ? Array.from(all) : [];
  candidates.sort((a, b) => count[b] - count[a]);
  /**
   * @param {number} e
   * @param {number} p
   */
  const near = (e, p) =>
    (lab[0][e] - lab[0][p]) ** 2 + (lab[1][e] - lab[1][p]) ** 2 + (lab[2][e] - lab[2][p]) ** 2 <
      FLAT_SEED_MIN_DISTANCE ** 2 || colorDistance(means[e], means[p]) <= layerDiff;
  for (const e of candidates) {
    if (common.some((p) => near(e, p))) commonCount += count[e];
    else if (common.length < colors && count[e] >= opaqueCount * FLAT_SEED_MIN_SHARE) {
      common.push(e);
      commonCount += count[e];
    }
  }
  // Flat art with spare slots: colors too rare for one, grouped within
  // half the accent distance, since a small accent's shading spreads it
  // over many bins that only add up together.
  /** @type {{ head: number, mass: number }[]} */
  const rare = [];
  if (common.length < colors && commonCount >= opaqueCount * FLAT_SEED_COVERAGE) {
    const chosen = new Set(common);
    for (const e of candidates) {
      if (chosen.has(e) || common.some((p) => near(e, p))) continue;
      const group = rare.find(
        ({ head }) =>
          (lab[0][e] - lab[0][head]) ** 2 +
            (lab[1][e] - lab[1][head]) ** 2 +
            (lab[2][e] - lab[2][head]) ** 2 <
          (FLAT_ACCENT_DISTANCE / 2) ** 2,
      );
      if (group) group.mass += count[e];
      else if (rare.length < FLAT_ACCENT_CANDIDATES) rare.push({ head: e, mass: count[e] });
    }
  }
  if (rare.length) {
    const accents = rare.filter(
      ({ head, mass }) =>
        mass >= opaqueCount * FLAT_SEED_MIN_SHARE * FLAT_ACCENT_SHARE &&
        common.every(
          (p) =>
            Math.hypot(
              lab[0][head] - lab[0][p],
              lab[1][head] - lab[1][p],
              lab[2][head] - lab[2][p],
            ) >= FLAT_ACCENT_DISTANCE,
        ),
    );
    accents.sort((a, b) => b.mass - a.mass);
    if (accents.length) {
      // Soft edges and stray pixels also leave far-off colors, but only a
      // real accent fills an area: some of its pixels have all four
      // neighbors in its own group.
      const groupOf = new Int32Array(binCount).fill(-1);
      accents.forEach((accent, g) => {
        for (const e of all) {
          if (
            (lab[0][e] - lab[0][accent.head]) ** 2 +
              (lab[1][e] - lab[1][accent.head]) ** 2 +
              (lab[2][e] - lab[2][accent.head]) ** 2 <
            (FLAT_ACCENT_DISTANCE / 2) ** 2
          ) {
            groupOf[entryBin[e]] = g;
          }
        }
      });
      const { width } = img;
      const height = data.length / 4 / width;
      /**
       * @param {number} p
       */
      const group = (p) => {
        const i = p * 4;
        return data[i + 3] < ALPHA_THRESHOLD
          ? -1
          : groupOf[binOf(data[i], data[i + 1], data[i + 2])];
      };
      const seen = new Float64Array(accents.length);
      const inside = new Float64Array(accents.length);
      for (let p = 0; p < width * height; p++) {
        const g = group(p);
        if (g < 0) continue;
        seen[g] += 1;
        const x = p % width;
        if (x === 0 || x === width - 1 || p < width || p >= width * (height - 1)) continue;
        if (
          group(p - 1) === g &&
          group(p + 1) === g &&
          group(p - width) === g &&
          group(p + width) === g
        ) {
          inside[g] += 1;
        }
      }
      accents.forEach((accent, g) => {
        if (common.length >= colors || inside[g] < seen[g] * SOLID_MIN_INTERIOR) return;
        common.push(accent.head);
      });
    }
  }
  const given = seeds?.length ? seeds.slice(0, colors) : null;
  const seeded = given !== null || commonCount >= opaqueCount * FLAT_SEED_COVERAGE;
  const boxes = given ? [] : seeded ? common.map((e) => makeBox(Int32Array.of(e))) : [makeBox(all)];
  while (boxes.length < colors) {
    let boxIndex = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].range >= 0 && (boxIndex === -1 || boxes[i].range > boxes[boxIndex].range)) {
        boxIndex = i;
      }
    }
    if (boxIndex === -1) break;
    const { members, channel } = boxes[boxIndex];
    const values = lab[channel];
    members.sort((a, b) => values[a] - values[b]);
    // Split at the pixel-weighted median so dominant colors get their own
    // box instead of being averaged away with rare neighbors.
    let totalCount = 0;
    for (const e of members) totalCount += count[e];
    let acc = 0;
    let half = 0;
    while (half < members.length - 1 && acc + count[members[half]] < totalCount / 2) {
      acc += count[members[half]];
      half += 1;
    }
    if (half === 0) half = 1;
    boxes.splice(boxIndex, 1, makeBox(members.subarray(0, half)), makeBox(members.subarray(half)));
  }

  // Weighted average color per box seeds the palette.
  const k = given ? given.length : boxes.length;
  const palette = new Float64Array(k * 3);
  given?.forEach((rgb, p) => palette.set(srgbToOklab(rgb), p * 3));
  boxes.forEach(({ members }, b) => {
    let total = 0;
    for (const e of members) {
      palette[b * 3] += lab[0][e] * count[e];
      palette[b * 3 + 1] += lab[1][e] * count[e];
      palette[b * 3 + 2] += lab[2][e] * count[e];
      total += count[e];
    }
    for (let c = 0; c < 3; c++) palette[b * 3 + c] /= total;
  });

  // Lloyd (k-means) refinement over the entries. Median-cut alone leaves
  // centroids off the natural clusters, so gradient pixels flip between
  // adjacent palette entries and trace into thousands of ragged paths.
  const assign = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * 4);
  const errors = new Float64Array(n);
  const minPopulation = opaqueCount * 0.001;
  // A small distinct flat color (an accent) does not take the blends of a
  // soft edge between two other fills, which often pass nearest to it and
  // would trace as slivers of it along those edges. Its own shades, and
  // blends of it with a neighbor, stay with it.
  const accentReach2 = (FLAT_ACCENT_DISTANCE / 2) ** 2;
  const accent = new Uint8Array(k);
  if (seeded) {
    for (let p = 0; p < k; p++) {
      let mass = 0;
      for (let e = 0; e < n; e++) {
        const dist =
          (lab[0][e] - palette[p * 3]) ** 2 +
          (lab[1][e] - palette[p * 3 + 1]) ** 2 +
          (lab[2][e] - palette[p * 3 + 2]) ** 2;
        if (dist < accentReach2) mass += count[e];
      }
      let nearest = Infinity;
      for (let q = 0; q < k; q++) {
        if (q === p) continue;
        nearest = Math.min(
          nearest,
          (palette[q * 3] - palette[p * 3]) ** 2 +
            (palette[q * 3 + 1] - palette[p * 3 + 1]) ** 2 +
            (palette[q * 3 + 2] - palette[p * 3 + 2]) ** 2,
        );
      }
      accent[p] =
        mass < opaqueCount * FLAT_ACCENT_MAX_SHARE && nearest >= FLAT_ACCENT_DISTANCE ** 2 ? 1 : 0;
    }
  }
  // Whether entry e lies between two palette colors other than p, as a
  // soft edge's blend does (RGB, with withoutBlendShades' tolerances).
  /**
   * @type {number[][]}
   */
  const paletteRgb = [];
  for (let p = 0; p < k; p++) {
    paletteRgb.push(oklabToSrgb([palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2]]));
  }
  /**
   * @param {number} e
   * @param {number} p
   */
  const mixOfOthers = (e, p) => {
    const c = means[e];
    for (let a = 0; a < k; a++) {
      if (a === p) continue;
      for (let b = a + 1; b < k; b++) {
        if (b === p) continue;
        const from = paletteRgb[a];
        const to = paletteRgb[b];
        const dr = to[0] - from[0];
        const dg = to[1] - from[1];
        const db = to[2] - from[2];
        const len2 = dr * dr + dg * dg + db * db;
        if (!len2) continue;
        const t = ((c[0] - from[0]) * dr + (c[1] - from[1]) * dg + (c[2] - from[2]) * db) / len2;
        if (t <= SHADE_END || t >= 1 - SHADE_END) continue;
        const residual2 =
          (c[0] - from[0] - t * dr) ** 2 +
          (c[1] - from[1] - t * dg) ** 2 +
          (c[2] - from[2] - t * db) ** 2;
        if (residual2 <= SHADE_TOLERANCE * SHADE_TOLERANCE) return true;
      }
    }
    return false;
  };
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let e = 0; e < n; e++) {
      const L = lab[0][e];
      const A = lab[1][e];
      const B = lab[2][e];
      let best = 0;
      let bestDist = Infinity;
      for (let p = 0; p < k; p++) {
        const dL = L - palette[p * 3];
        const dA = A - palette[p * 3 + 1];
        const dB = B - palette[p * 3 + 2];
        const dist = dL * dL + dA * dA + dB * dB;
        if (dist < bestDist && accent[p] && dist >= accentReach2 && mixOfOthers(e, p)) continue;
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      errors[e] = bestDist * count[e];
      if (assign[e] !== best) {
        assign[e] = best;
        changed = true;
      }
    }
    // Seeded flat colors are the artwork's own: keep them exact rather
    // than letting the blends assigned to them pull them off.
    if (seeded) break;
    sums.fill(0);
    for (let e = 0; e < n; e++) {
      const p = assign[e] * 4;
      sums[p] += lab[0][e] * count[e];
      sums[p + 1] += lab[1][e] * count[e];
      sums[p + 2] += lab[2][e] * count[e];
      sums[p + 3] += count[e];
    }
    for (let p = 0; p < k; p++) {
      const w = sums[p * 4 + 3];
      if (w > 0) {
        palette[p * 3] = sums[p * 4] / w;
        palette[p * 3 + 1] = sums[p * 4 + 1] / w;
        palette[p * 3 + 2] = sums[p * 4 + 2] / w;
      }
    }
    // Reclaim slots below 0.1% coverage for the largest weighted error.
    // Leave a final assignment pass after reseeding before emitting pixels.
    if (iter < 9) {
      for (let p = 0; p < k; p++) {
        if (sums[p * 4 + 3] >= minPopulation) continue;
        let worst = -1;
        let worstError = 1e-12;
        for (let e = 0; e < n; e++) {
          if (sums[assign[e] * 4 + 3] >= minPopulation && errors[e] > worstError) {
            worst = e;
            worstError = errors[e];
          }
        }
        if (worst === -1) continue;
        for (let c = 0; c < 3; c++) palette[p * 3 + c] = lab[c][worst];
        errors[worst] = 0;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Painted fill colors join after clustering, exact and fixed, so they
  // neither take the image's own slots nor pull its colors off.
  const rgb = new Uint8Array((k + kept.length) * 3);
  for (let p = 0; p < k; p++) {
    rgb.set(oklabToSrgb([palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2]]), p * 3);
  }
  if (kept.length) {
    const keptLab = kept.map((color) => srgbToOklab(color));
    kept.forEach((color, j) => rgb.set(color, (k + j) * 3));
    for (let e = 0; e < n; e++) {
      let bestDist = Infinity;
      for (let p = 0; p < k; p++) {
        const dist =
          (lab[0][e] - palette[p * 3]) ** 2 +
          (lab[1][e] - palette[p * 3 + 1]) ** 2 +
          (lab[2][e] - palette[p * 3 + 2]) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          assign[e] = p;
        }
      }
      keptLab.forEach(([L, A, B], j) => {
        const dist = (lab[0][e] - L) ** 2 + (lab[1][e] - A) ** 2 + (lab[2][e] - B) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          assign[e] = k + j;
        }
      });
    }
  }
  const binToPalette = new Int32Array(binCount);
  for (let e = 0; e < n; e++) binToPalette[entryBin[e]] = assign[e];
  const backfillEntry = binToPalette[binOf(backfill[0], backfill[1], backfill[2])] * 3;
  for (let i = 0; i < data.length; i += 4) {
    const p =
      data[i + 3] < ALPHA_THRESHOLD
        ? backfillEntry
        : binToPalette[binOf(data[i], data[i + 1], data[i + 2])] * 3;
    data[i] = rgb[p];
    data[i + 1] = rgb[p + 1];
    data[i + 2] = rgb[p + 2];
  }
  return seeded ? "flat" : "clustered";
}

/**
 * 3x3 per-channel median filter on opaque RGB, repeated `passes` times.
 * Kills sensor/compression noise while preserving edges exactly, unlike
 * a blur which grays the very boundaries the tracer follows. Alpha is
 * untouched and transparent neighbors are excluded from the window.
 * @param {ImageData} img
 */
export function medianFilter(img, passes = 1) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data.length);
  // A 3x3 window holds at most nine samples per channel. One fixed buffer
  // plus an insertion sort avoids three Array#sort calls with a JS
  // comparator per pixel, which dominated the cost of this filter.
  const win = new Uint8Array(27);

  for (let pass = 0; pass < passes; pass++) {
    out.set(data);
    for (let y = 0; y < height; y++) {
      const yStart = y > 0 ? -1 : 0;
      const yEnd = y < height - 1 ? 1 : 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < ALPHA_THRESHOLD) continue;
        const xStart = x > 0 ? -1 : 0;
        const xEnd = x < width - 1 ? 1 : 0;
        let count = 0;
        for (let dy = yStart; dy <= yEnd; dy++) {
          let j = ((y + dy) * width + x + xStart) * 4;
          for (let dx = xStart; dx <= xEnd; dx++, j += 4) {
            if (data[j + 3] < ALPHA_THRESHOLD) continue;
            win[count] = data[j];
            win[count + 9] = data[j + 1];
            win[count + 18] = data[j + 2];
            count += 1;
          }
        }
        const mid = count >> 1;
        for (let c = 0; c < 3; c++) {
          const base = c * 9;
          for (let k = base + 1; k < base + count; k++) {
            const value = win[k];
            let m = k - 1;
            while (m >= base && win[m] > value) {
              win[m + 1] = win[m];
              m -= 1;
            }
            win[m + 1] = value;
          }
          out[i + c] = win[base + mid];
        }
      }
    }
    data.set(out);
  }
  return img;
}

/**
 * 3x3 majority filter on opaque RGB values. Cleans single-pixel dithering
 * left along region boundaries after quantization, which otherwise traces
 * into hundreds of tiny paths. Alpha is untouched. Returns a new buffer
 * written back into img.
 * @param {ImageData} img
 */
export function modeFilter(img) {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data);
  // At most nine neighbors, so a linear scan over fixed buffers beats
  // hashing each key through a Map that has to be cleared per pixel.
  const keys = new Int32Array(9);
  const tally = new Int32Array(9);
  for (let y = 0; y < height; y++) {
    const yStart = y > 0 ? -1 : 0;
    const yEnd = y < height - 1 ? 1 : 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < ALPHA_THRESHOLD) continue;
      const xStart = x > 0 ? -1 : 0;
      const xEnd = x < width - 1 ? 1 : 0;
      let unique = 0;
      let best = -1;
      let bestCount = 0;
      for (let dy = yStart; dy <= yEnd; dy++) {
        let j = ((y + dy) * width + x + xStart) * 4;
        for (let dx = xStart; dx <= xEnd; dx++, j += 4) {
          if (data[j + 3] < ALPHA_THRESHOLD) continue;
          const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
          let slot = 0;
          while (slot < unique && keys[slot] !== key) slot += 1;
          if (slot === unique) {
            keys[slot] = key;
            tally[slot] = 0;
            unique += 1;
          }
          const n = ++tally[slot];
          if (n > bestCount) {
            bestCount = n;
            best = key;
          }
        }
      }
      // Replace only clear majorities so real detail survives.
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

/**
 * Resolve preset + explicit values the same way the CLI does:
 * explicit user values win over preset values, preset over defaults.
 * `explicit` holds only the keys the user actually set.
 * @param {string | number | null | undefined} preset PRESETS key
 * @param {Record<string, unknown>} [explicit]
 */
export function resolveSettings(preset, explicit = {}) {
  /** @type {Record<string, unknown>} */
  const merged = { ...DEFAULTS, ...(preset ? PRESETS[preset] : {}) };
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}
